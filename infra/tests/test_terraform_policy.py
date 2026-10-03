"""A resource-owner change or broad state export needs an explicit security re-review."""
import contextlib
import io
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from check_terraform_policy import ROOT, check


class PolicyTests(unittest.TestCase):
    def test_security_surface_mutations_are_refused(self):
        with contextlib.redirect_stdout(io.StringIO()): check()
        for filename,before,after in [
            ('foundation/main.tf','Microsoft.OperationalInsights/workspaces','Microsoft.KeyVault/vaults/secrets'),
            ('foundation/main.tf','response_export_values = []','response_export_values = ["*"]'),
            ('application/versions.tf','disable_default_output = true','disable_default_output = false'),
        ]:
            with self.subTest(filename=filename),tempfile.TemporaryDirectory() as d:
                root=Path(d)/'terraform';shutil.copytree(ROOT,root,ignore=shutil.ignore_patterns('.terraform'))
                path=root/filename;source=path.read_text();self.assertIn(before,source);path.write_text(source.replace(before,after,1))
                with self.assertRaises(ValueError): check(root)
