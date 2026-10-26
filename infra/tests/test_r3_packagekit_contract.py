"""Option C PR-C1 static contract: T-READONLY, T-IMPORT and T-BUNDLE. Source parsing only,
so the installer and bundle mutants can be routed here without the synthetic-host suite."""
import ast
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_packagekit_state as state


class ReadOnly(unittest.TestCase):
    """T-READONLY: the state module's argv set, its one subprocess call and forbidden tokens."""
    FORBIDDEN = {'start', 'stop', 'kill', 'restart', 'reload', 'daemon-reload', 'mask', 'unmask', 'gdbus', 'busctl',
                 'pkcon', 'systemd-run', 'enable', 'disable', 'isolate', 'try-restart', 'reload-or-restart', 'reset-failed'}

    def tree(self):
        return ast.parse((SCRIPTS / 'r3_packagekit_state.py').read_text())

    def test_one_subprocess_call_with_the_fixed_argv(self):
        tree = self.tree()
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and isinstance(node.func.value, ast.Name) and node.func.value.id in ('subprocess', 'os')
                 and node.func.attr in ('run', 'Popen', 'call', 'check_call', 'check_output', 'system', 'popen',
                                        'kill', 'killpg', 'execv', 'execve', 'execvp', 'execvpe', 'execl', 'execle',
                                        'execlp', 'execlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe', 'spawnl',
                                        'spawnle', 'spawnlp', 'spawnlpe', 'posix_spawn', 'posix_spawnp', 'fork',
                                        'forkpty', 'startfile')]
        self.assertEqual([(c.func.value.id, c.func.attr) for c in calls], [('subprocess', 'run')])
        function = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == 'execute')
        self.assertIn(calls[0], list(ast.walk(function)))
        seen = []
        with patch.object(state.subprocess, 'run', side_effect=lambda argv, **kw: seen.append((argv, kw)) or
                          type('R', (), {'stdout': b'', 'stderr': b'', 'returncode': 0})()):
            for name in state.COMMANDS:
                state.command(name)
        self.assertEqual([argv for argv, _ in seen], list(state.COMMANDS.values()))
        self.assertTrue(all(kw['env'] is state.ENV and kw['stdin'] == state.subprocess.DEVNULL for _, kw in seen))
        with self.assertRaises(KeyError):
            state.command('systemctl-mask')

    def test_no_socket_connect_or_forbidden_command_token(self):
        tree = self.tree()
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module)
            elif isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, ('connect', 'connect_ex', 'sendmsg', 'kill', 'killpg', 'posix_spawn',
                                             'posix_spawnp', 'forkpty', 'execl', 'execlp', 'spawnl', 'spawnlp'))
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, ('getattr', '__import__', 'eval', 'exec', 'compile'))  # no indirect calls
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                self.assertNotIn(node.value, self.FORBIDDEN)
                # The bus name appears only as C1's expected Name=; never an interface, path or method.
                self.assertTrue(node.value == 'org.freedesktop.PackageKit' or not node.value.startswith('org.freedesktop.PackageKit'))
        self.assertEqual(imported, {'base64', 'binascii', 'hashlib', 'os', 'pathlib', 're', 'stat', 'subprocess', 'time',
                                    'types', 'r3_policy_capture', 'r3_noble_common'})
        # No name imported from a module could alias a process or socket call.
        names = {(node.module, alias.name) for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) for alias in node.names}
        self.assertEqual(names, {('pathlib', 'PurePosixPath'), ('r3_noble_common', 'ENV'), ('r3_noble_common', 'digest'),
                                 ('r3_noble_common', 'encoded')})
        argv = {token for value in state.COMMANDS.values() for token in value}
        self.assertEqual(argv & self.FORBIDDEN, set())
        self.assertEqual({value[0] for value in state.COMMANDS.values()}, {'systemctl', 'dpkg-query'})
        self.assertEqual({value[1] for value in state.COMMANDS.values()}, {'show', '-W'})

    def test_installer_and_maintenance_never_name_packagekit_service_or_unmask(self):
        for name in ('r3_install.py', 'r3_maintenance.py', 'r3_install_policy.py'):
            text = (SCRIPTS / name).read_text()
            with self.subTest(module=name):
                self.assertNotIn('unmask', text)
                self.assertNotIn("'packagekit.service'", text)


def local_imports(name):
    tree = ast.parse((SCRIPTS / (name + '.py')).read_text())
    found = set()
    for node in ast.walk(tree):  # every node: nested and function-local imports too
        if isinstance(node, ast.Import):
            found |= {alias.name.split('.')[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            found.add(node.module.split('.')[0])
    return {module for module in found if (SCRIPTS / (module + '.py')).exists()}


# Named, pre-existing exception: replacement_bundle.backend_binding imports
# bootstrap_backend for the controller-side Terraform check; it is never called on a host.
CONTROLLER_ONLY = {('replacement_bundle', 'bootstrap_backend')}


def closure(roots):
    seen, todo = set(), list(roots)
    while todo:
        module = todo.pop()
        if module in seen:
            continue
        seen.add(module)
        todo += [m for m in local_imports(module) if (module, m) not in CONTROLLER_ONLY]
    return seen


class Imports(unittest.TestCase):
    """T-IMPORT: every shipped or approval-hashed helper list is import-closed."""
    def modules(self, names):
        return {name.removesuffix('.py') for name in names if name.endswith('.py')}

    def test_bundles_and_packets_are_closed(self):
        import r3_artifacts
        import r3_noble_inputs
        import r3_policy_packet
        for label, names in (('B install bundle', self.modules(r3_artifacts.HELPERS)),
                             ('A ISO', self.modules(r3_noble_inputs.HELPERS)),
                             ('B collection packet', set(r3_policy_packet.MODULES))):
            with self.subTest(list=label):
                self.assertLessEqual(closure(names), names)
                self.assertIn('r3_packagekit_state', names)
                self.assertIn('r3_policy_capture', names)

    def test_install_approval_hashes_its_whole_closure(self):
        tree = ast.parse((SCRIPTS / 'r3_install.py').read_text())
        bound = {'r3_install'}
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'with_name'
                    and isinstance(node.args[0], ast.Constant)):
                bound.add(node.args[0].value.removesuffix('.py'))
            if isinstance(node, ast.For) and isinstance(node.iter, ast.Tuple):
                bound |= {item.value.removesuffix('.py') for item in node.iter.elts
                          if isinstance(item, ast.Constant) and str(item.value).endswith('.py')}
        self.assertLessEqual(closure({'r3_install'}), bound)
        self.assertLessEqual({'r3_packagekit_state', 'r3_policy_capture', 'r3_install_policy'}, bound)

    def test_the_exception_list_is_exactly_the_named_one(self):
        import r3_artifacts
        names = self.modules(r3_artifacts.HELPERS)
        outside = {(module, imported) for module in names for imported in local_imports(module) if imported not in names}
        self.assertEqual(outside, CONTROLLER_ONLY)


class Bundle(unittest.TestCase):
    """T-BUNDLE: no mask code exists in PR-C1, and none may travel with install or collection."""
    def test_mask_helper_is_absent(self):
        import r3_artifacts
        import r3_noble_inputs
        import r3_policy_packet
        self.assertFalse((SCRIPTS / 'r3_packagekit_mask.py').exists())
        self.assertNotIn('r3_packagekit_mask.py', r3_artifacts.HELPERS)
        self.assertNotIn('r3_packagekit_mask', r3_policy_packet.MODULES)
        self.assertNotIn('r3_packagekit_mask.py', r3_noble_inputs.HELPERS)


if __name__ == '__main__':
    unittest.main()
