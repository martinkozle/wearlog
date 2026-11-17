import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        server.DB = self.temp.name + '/test.sqlite3'
        self.g = dict(id='g', type='garment', name='Blue', group='Merino', photo='', recordedAt='2026-11-17T09:00:00Z')
        self.w = dict(id='w', type='wear', garmentId='g', quantity=2, wornOn=None, recordedAt='2026-11-17T09:01:00Z')
    def tearDown(self):
        self.temp.cleanup()
    def test_retry_does_not_duplicate(self):
        server.sync([self.g,self.w])
        self.assertEqual(len(server.sync([self.w])),2)
    def test_collision_rolls_back_whole_batch(self):
        server.sync([self.g])
        with self.assertRaises(ValueError):
            server.sync([self.w,dict(self.g,name='Other')])
        self.assertEqual(len(server.sync([])),1)
    def test_invalid_batch_saves_nothing(self):
        for invalid in [dict(self.w,quantity=-1),dict(self.w,wornOn='banana'),dict(self.g,photo='data:image/svg+xml,evil'),dict(self.w,quantity=True)]:
            with self.assertRaises(ValueError):
                server.sync([self.g,invalid])
            self.assertEqual(server.sync([]),[])
    def test_history_survives_new_connection(self):
        server.sync([self.g,self.w])
        self.assertEqual(server.sync([]),[self.g,self.w])
if __name__ == '__main__':
    unittest.main()
