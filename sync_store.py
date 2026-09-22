"""Durable, token-protected device sync using Upstash Redis over HTTPS."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from urllib.request import Request, urlopen

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
CODE_LIFETIME = 600
ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


class SyncError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def configured() -> bool:
    return bool(os.environ.get('UPSTASH_REDIS_REST_URL') and os.environ.get('UPSTASH_REDIS_REST_TOKEN'))


def redis_command(*parts):
    if not configured():
        raise SyncError('Device sync is not configured yet.', 503)
    endpoint = os.environ['UPSTASH_REDIS_REST_URL'].rstrip('/')
    token = os.environ['UPSTASH_REDIS_REST_TOKEN']
    body = json.dumps(parts, separators=(',', ':')).encode('utf-8')
    request = Request(endpoint, data=body, headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, method='POST')
    try:
        with urlopen(request, timeout=10) as response:
            result = json.load(response)
    except Exception as exc:
        raise SyncError('Sync storage is temporarily unavailable. Try again soon.', 503) from exc
    if 'error' in result:
        raise SyncError('Sync storage is temporarily unavailable. Try again soon.', 503)
    return result.get('result')


def room_key(token: str) -> str:
    if not isinstance(token, str) or len(token) != 43:
        raise SyncError('This device is not connected to a sync space.', 401)
    try:
        raw = base64.urlsafe_b64decode(token + '=')
    except (ValueError, TypeError) as exc:
        raise SyncError('This device is not connected to a sync space.', 401) from exc
    if len(raw) != 32:
        raise SyncError('This device is not connected to a sync space.', 401)
    return 'tesokeu:room:' + hashlib.sha256(raw).hexdigest()


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get('format') != 'tesokeu-sync' or snapshot.get('version') != 1:
        raise SyncError('This reading data is not valid.')
    library = snapshot.get('library')
    if not isinstance(library, dict) or not isinstance(library.get('books'), list) or len(library['books']) > 1000:
        raise SyncError('This bookshelf is not valid.')
    for book in library['books']:
        if not isinstance(book, dict) or not isinstance(book.get('id'), str) or not isinstance(book.get('title'), str) or not isinstance(book.get('text'), str):
            raise SyncError('A book in this bookshelf is not valid.')
    if not isinstance(snapshot.get('settings'), dict) or not isinstance(snapshot.get('stats'), dict):
        raise SyncError('This reading data is incomplete.')
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))
    if len(encoded.encode('utf-8')) > MAX_SNAPSHOT_BYTES:
        raise SyncError('This bookshelf is too large to sync. Try a shorter collection.')
    return encoded


def make_code(token: str) -> str:
    for _ in range(5):
        code = ''.join(secrets.choice(ALPHABET) for _ in range(12))
        if redis_command('SET', 'tesokeu:code:' + code, token, 'EX', CODE_LIFETIME, 'NX') == 'OK':
            return '-'.join((code[:4], code[4:8], code[8:]))
    raise SyncError('Could not make a device code. Try again.', 503)


def create_room(snapshot):
    encoded = validate_snapshot(snapshot)
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('ascii').rstrip('=')
    redis_command('HSET', room_key(token), 'revision', '1', 'snapshot', encoded)
    return {'token': token, 'revision': 1, 'code': make_code(token), 'expiresIn': CODE_LIFETIME}


def new_code(token: str):
    get_room(token)
    return {'code': make_code(token), 'expiresIn': CODE_LIFETIME}


def join_room(code: str):
    normalized = ''.join(character for character in str(code).upper() if character not in '- ')
    if len(normalized) != 12 or any(character not in ALPHABET for character in normalized):
        raise SyncError('Enter the 12-character code shown on your other device.')
    token = redis_command('GETDEL', 'tesokeu:code:' + normalized)
    if not token:
        raise SyncError('This code is invalid or has expired. Make a new one on your other device.')
    room = get_room(token)
    return {'token': token, **room}


def get_room(token: str):
    values = redis_command('HMGET', room_key(token), 'revision', 'snapshot')
    if not values or not values[0] or not values[1]:
        raise SyncError('This sync space is no longer available.', 404)
    return {'revision': int(values[0]), 'snapshot': json.loads(values[1])}


UPDATE_SCRIPT = """
local revision = redis.call('HGET', KEYS[1], 'revision')
if not revision then return -1 end
if tonumber(revision) ~= tonumber(ARGV[1]) then return 0 end
local next_revision = tonumber(revision) + 1
redis.call('HSET', KEYS[1], 'revision', tostring(next_revision), 'snapshot', ARGV[2])
return next_revision
"""


def update_room(token: str, revision: int, snapshot):
    if not isinstance(revision, int) or revision < 1:
        raise SyncError('The sync version is not valid.')
    encoded = validate_snapshot(snapshot)
    result = redis_command('EVAL', UPDATE_SCRIPT, 1, room_key(token), revision, encoded)
    if result == 0:
        raise SyncError('Another device updated this collection.', 409)
    if result == -1:
        raise SyncError('This sync space is no longer available.', 404)
    return {'revision': int(result)}


def delete_room(token: str):
    if not redis_command('DEL', room_key(token)):
        raise SyncError('This sync space is no longer available.', 404)
    return {'deleted': True}
