import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import sync_store
from server import Handler


class FakeRedis:
    def __init__(self):
        self.rooms = {}
        self.codes = {}

    def __call__(self, command, *args):
        if command == 'HSET':
            key = args[0]
            self.rooms[key] = {'revision': args[2], 'snapshot': args[4]}
            return 2
        if command == 'HMGET':
            room = self.rooms.get(args[0], {})
            return [room.get('revision'), room.get('snapshot')]
        if command == 'SET':
            if args[0] in self.codes:
                return None
            self.codes[args[0]] = args[1]
            return 'OK'
        if command == 'GETDEL':
            return self.codes.pop(args[0], None)
        if command == 'EVAL':
            key, revision, snapshot = args[2:]
            room = self.rooms.get(key)
            if not room:
                return -1
            if int(room['revision']) != revision:
                return 0
            room.update(revision=str(revision + 1), snapshot=snapshot)
            return revision + 1
        if command == 'DEL':
            return int(self.rooms.pop(args[0], None) is not None)
        raise AssertionError(command)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.redis = FakeRedis()
        self.patcher = patch.object(sync_store, 'redis_command', self.redis)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.snapshot = {
            'format': 'tesokeu-sync', 'version': 1,
            'library': {'books': [{'id': 'a', 'title': 'A book', 'text': 'A short book', 'position': 1}], 'activeId': 'a'},
            'settings': {'speed': 300}, 'stats': {'totalWords': 1, 'daily': {}}, 'goal': None,
        }

    def test_code_joins_once_and_revision_prevents_overwrite(self):
        created = sync_store.create_room(self.snapshot)
        joined = sync_store.join_room(created['code'])
        self.assertEqual(joined['snapshot'], self.snapshot)
        self.assertEqual(joined['token'], created['token'])
        with self.assertRaises(sync_store.SyncError):
            sync_store.join_room(created['code'])
        updated = json.loads(json.dumps(self.snapshot))
        updated['library']['books'][0]['position'] = 2
        self.assertEqual(sync_store.update_room(created['token'], 1, updated)['revision'], 2)
        with self.assertRaises(sync_store.SyncError) as conflict:
            sync_store.update_room(created['token'], 1, self.snapshot)
        self.assertEqual(conflict.exception.status, 409)
        self.assertEqual(sync_store.get_room(created['token'])['snapshot'], updated)

    def test_delete_removes_remote_copy(self):
        created = sync_store.create_room(self.snapshot)
        sync_store.delete_room(created['token'])
        with self.assertRaises(sync_store.SyncError) as missing:
            sync_store.get_room(created['token'])
        self.assertEqual(missing.exception.status, 404)

    def test_rejects_invalid_snapshot(self):
        with self.assertRaises(sync_store.SyncError):
            sync_store.create_room({'format': 'tesokeu-sync', 'version': 1, 'library': {'books': [{}]}, 'settings': {}, 'stats': {}})

    def test_http_pair_and_sync(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        origin = f'http://127.0.0.1:{server.server_port}'

        def call(path, method='GET', body=None, token=None):
            headers = {'Origin': origin}
            if body is not None:
                headers['Content-Type'] = 'application/json'
            if token:
                headers['Authorization'] = f'Bearer {token}'
            request = Request(origin + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
            with urlopen(request, timeout=5) as response:
                return json.load(response)

        created = call('/api/sync/create', 'POST', {'snapshot': self.snapshot})
        joined = call('/api/sync/join', 'POST', {'code': created['code']})
        self.assertEqual(joined['snapshot'], self.snapshot)
        self.assertEqual(joined['token'], created['token'])
        updated = json.loads(json.dumps(self.snapshot))
        updated['library']['books'][0]['position'] = 4
        saved = call('/api/sync/state', 'PUT', {'revision': 1, 'snapshot': updated}, created['token'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(call('/api/sync/state', token=joined['token'])['snapshot'], updated)
        with self.assertRaises(HTTPError) as conflict:
            call('/api/sync/state', 'PUT', {'revision': 1, 'snapshot': self.snapshot}, joined['token'])
        self.assertEqual(conflict.exception.code, 409)


if __name__ == '__main__':
    unittest.main()
