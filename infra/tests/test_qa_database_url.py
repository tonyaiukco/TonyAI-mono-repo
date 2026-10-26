"""No live URL or credential is used; role and TLS override refusals."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_database_url import validate

RUNTIME = 'postgresql://tonyai_runtime:synthetic@db.qa.tonyai.internal:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/qa-db-ca.crt'


class URLs(unittest.TestCase):
    def test_runtime_and_owner_are_distinct(self):
        validate(RUNTIME)
        validate(RUNTIME.replace('tonyai_runtime:', 'postgres:'), owner=True)
        with self.assertRaises(Exception):
            validate(RUNTIME, owner=True)
        with self.assertRaises(Exception):
            validate(RUNTIME.replace('tonyai_runtime:', 'postgres:'))

    def test_overrides_and_non_tls_routes_refused(self):
        for value in [RUNTIME + '&host=evil', RUNTIME + '&sslaccept=accept_invalid_certs',
                      RUNTIME.replace('strict', 'accept_invalid_certs'), RUNTIME.replace('require', 'disable'),
                      RUNTIME.replace('db.qa.tonyai.internal', '10.80.1.4'),
                      RUNTIME.replace(':5432/', ':6543/'), RUNTIME.replace('sslcert=', 'sslrootcert='),
                      RUNTIME + '#fragment', RUNTIME + '\n', RUNTIME.replace('synthetic@', '@')]:
            with self.subTest(value=value), self.assertRaises(Exception):
                validate(value)


if __name__ == '__main__':
    unittest.main()
