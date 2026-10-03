"""Provider DSN placeholders must not become runtime passwords or weaken host binding."""
import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
from urllib.parse import unquote, urlparse
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from runtime_urls import transfer_urls
from pooler import SafeFailure, validate_pooler

REF = 'abcdefghijklmnopqrst'
HOST = 'aws-0-eu-central-1.pooler.supabase.com'
DSN = 'postgresql://postgres.' + REF + ':[YOUR-PASSWORD]@' + HOST + ':6543/postgres'


class ProviderPoolerTests(unittest.TestCase):
    def vault(self):
        vault = Mock()
        vault.get.return_value = {'value': 'synthetic@:/password'}
        vault.identifier.return_value = 'https://vault.vault.azure.net/secrets/bootstrap-db-password/' + 'b'*32
        vault.put.side_effect = lambda name, value, tags: 'https://vault.vault.azure.net/secrets/' + name + '/' + 'a'*32
        return vault

    def test_literal_and_encoded_placeholders_build_urls_from_vault_password(self):
        for dsn in (DSN, DSN.replace('[YOUR-PASSWORD]', '%5BYOUR-PASSWORD%5D'), DSN.replace('postgresql:', 'postgres:')):
            vault = self.vault(); journal = Mock(); journal.data = {}
            api = Mock(return_value=[{'database_type':'PRIMARY', 'connection_string':dsn}])
            try:
                versions = transfer_urls(api, vault, REF, journal)
            except Exception as error:
                self.fail('Provider placeholder transfer failed: ' + type(error).__name__)
            self.assertEqual(set(versions), {'database_url_version', 'direct_url_version'})
            self.assertEqual(vault.put.call_count, 2)
            for call in vault.put.call_args_list:
                name, value, tags = call.args
                validate_pooler(value, REF, 6543 if name == 'database-url' else 5432)
                self.assertEqual(unquote(urlparse(value).password), 'synthetic@:/password')
                self.assertNotIn('YOUR-PASSWORD', value)
                self.assertEqual(tags, {'project':REF})
            journal.set.assert_called_once()
            vault.disable.assert_called_once_with('bootstrap-db-password', 'b'*32)

    def test_invalid_foreign_missing_or_ambiguous_primary_metadata_stops_before_vault(self):
        invalid = [None, 'postgresql://user:[broken@host/postgres', 'not-a-url',
                   DSN.replace('eu-central-1', 'us-east-1'), DSN.replace(HOST, HOST+'.evil.invalid')]
        inventories = [[{'database_type':'PRIMARY', 'connection_string':dsn}] for dsn in invalid]
        inventories += [[], [{'database_type':'REPLICA', 'connection_string':DSN}],
                        [{'database_type':'PRIMARY'}],
                        [{'database_type':'PRIMARY', 'connection_string':dsn}
                         for dsn in (DSN, DSN.replace('aws-0-', 'aws-1-'))]]
        for rows in inventories:
            vault = self.vault(); journal = Mock(); journal.data = {}
            with self.subTest(rows=rows), self.assertRaises(SafeFailure) as failure:
                transfer_urls(Mock(return_value=rows), vault, REF, journal)
            self.assertNotIn('YOUR-PASSWORD', str(failure.exception))
            vault.get.assert_not_called(); vault.put.assert_not_called(); vault.disable.assert_not_called()
            journal.set.assert_not_called()
