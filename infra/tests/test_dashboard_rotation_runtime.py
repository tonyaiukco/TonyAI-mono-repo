"""Docker and private HTTP boundary assertions using synthetic payloads only."""
import hashlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from dashboard_rotation_runtime import Runtime, NoRedirect
from test_selfhost_runtime import config

IMAGE='envoyproxy/envoy@sha256:'+'a'*64


def composition(password='synthetic-password'):
    value=config()
    for service in value['services'].values():service['image']=IMAGE
    value['services']['api-gw'].update(
        restart='unless-stopped',container_name='supabase-envoy',entrypoint=['/bin/sh','/docker-entrypoint.sh'],
        environment={'DASHBOARD_USERNAME':'tonyaiops','DASHBOARD_PASSWORD':password})
    return value


def gateway():
    return {'id':'b'*64,'name':'/supabase-envoy','project':'supabase','service':'api-gw','image':IMAGE,
            'running':True,'started':'synthetic-time','restart':'unless-stopped',
            'ports':{'8000/tcp':[{'HostIp':'127.0.0.1','HostPort':'8000'}]}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.runtime=Runtime(SimpleNamespace(runtime=Path('/opt/tonyai/supabase'),env=Path('/opt/tonyai/supabase/.env')),Path('/root/rotation'))
        self.lock=json.dumps({'services':{'api-gw':{'image':IMAGE}}}).encode()

    def test_only_gateway_recreated_without_pull_build_dependencies_or_ambient_settings(self):
        with patch('dashboard_rotation_runtime.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=b'')) as run:
            self.runtime.recreate()
        args=run.call_args.args[0]
        self.assertEqual(args[args.index('up'):],['up','-d','--no-deps','--force-recreate','--pull','never','--no-build','--wait','--wait-timeout','240','api-gw'])
        self.assertEqual(args[:3],['/usr/bin/docker','--host','unix:///var/run/docker.sock'])
        self.assertEqual(run.call_args.kwargs['env'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
        self.assertTrue(run.call_args.kwargs['capture_output'])
        self.assertNotIn('synthetic-password',str(run.call_args))

    def test_private_docker_failure_never_forwards_output(self):
        with patch('dashboard_rotation_runtime.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout=b'synthetic-secret',stderr=b'synthetic-secret')):
            with self.assertRaises(ValueError) as caught:self.runtime.recreate()
        self.assertNotIn('synthetic-secret',str(caught.exception))

    def test_configuration_fingerprint_allows_only_dashboard_password_change(self):
        with patch.object(self.runtime,'call',return_value=json.dumps(composition()).encode()):
            first=self.runtime.configuration(b'tonyaiops',b'synthetic-password')
        with patch.object(self.runtime,'call',return_value=json.dumps(composition('new-password')).encode()):
            second=self.runtime.configuration(b'tonyaiops',b'new-password')
        self.assertEqual(first,second)
        changed=composition('new-password');changed['services']['db']['environment']={'UNEXPECTED':'value'}
        with patch.object(self.runtime,'call',return_value=json.dumps(changed).encode()):
            self.assertNotEqual(first,self.runtime.configuration(b'tonyaiops',b'new-password'))

    def test_unreviewed_gateway_and_secondary_consumer_refused(self):
        for kind in ('restart','name','entrypoint','consumer','password','public-port','mutable-image'):
            value=composition(); gw=value['services']['api-gw']
            if kind=='restart':gw['restart']='always'
            if kind=='name':gw['container_name']='foreign'
            if kind=='entrypoint':gw['entrypoint']=['sh','-c','unexpected']
            if kind=='consumer':value['services']['db']['environment']={'DASHBOARD_PASSWORD':'synthetic-password'}
            if kind=='password':gw['environment']['DASHBOARD_PASSWORD']='wrong'
            if kind=='public-port':gw['ports'][0]['host_ip']='0.0.0.0'
            if kind=='mutable-image':gw['image']='envoyproxy/envoy:latest'
            with self.subTest(kind=kind),patch.object(self.runtime,'call',return_value=json.dumps(value).encode()),self.assertRaises(ValueError):
                self.runtime.configuration(b'tonyaiops',b'synthetic-password')

    def test_stopped_container_environment_must_match_composition_and_image_defaults(self):
        value=composition();value['services']['api-gw']['environment']['SERVICE_ROLE_KEY']='synthetic-current-key'
        expected=dict(value['services']['api-gw']['environment'],PATH='/image/path')
        for kind in ('matching','stale-key','extra-variable','missing-default'):
            actual=dict(expected)
            if kind=='stale-key':actual['SERVICE_ROLE_KEY']='synthetic-stale-key'
            if kind=='extra-variable':actual['UNREVIEWED']='unexpected'
            if kind=='missing-default':del actual['PATH']
            with self.subTest(kind=kind),patch.object(self.runtime,'call',side_effect=[json.dumps(value).encode(),b'["PATH=/image/path"]']), \
                 patch.object(self.runtime,'gateway_environment',return_value=actual):
                if kind=='matching':self.runtime.configuration(b'tonyaiops',b'synthetic-password',gateway_id='b'*64)
                else:
                    with self.assertRaises(ValueError):self.runtime.configuration(b'tonyaiops',b'synthetic-password',gateway_id='b'*64)

    def test_live_gateway_image_port_restart_and_identity_are_pinned(self):
        with patch('dashboard_rotation_runtime.read',return_value=self.lock):
            self.runtime.gateway({'api-gw':gateway()})
            for key,value in [('name','/wrong'),('image','envoyproxy/envoy:latest'),('restart','always'),('ports',{})]:
                item=gateway();item[key]=value
                with self.subTest(key=key),self.assertRaises(ValueError):self.runtime.gateway({'api-gw':item})

    def test_stopped_and_old_environment_checks_are_both_required(self):
        with patch('dashboard_rotation_runtime.read',return_value=self.lock),patch.object(self.runtime,'gateway_environment',return_value={'DASHBOARD_PASSWORD':'old'}):
            item=gateway()
            with self.assertRaises(ValueError):self.runtime.require_stopped({'api-gw':item},b'old')
            item['running']=False
            self.runtime.require_stopped({'api-gw':item},b'old')
            with self.assertRaises(ValueError):self.runtime.require_stopped({'api-gw':item},b'different')

    def test_dependency_restarts_and_replacements_are_detected(self):
        original={'api-gw':gateway(),'db':{'id':'d','started':'t1'}}
        for variant in ({'id':'new','started':'t1'},{'id':'d','started':'t2'}):
            with patch.object(self.runtime,'inventory',return_value={'api-gw':gateway(),'db':variant}),self.assertRaises(ValueError):
                self.runtime.require_dependencies(original)

    def test_containment_stops_exact_identity_even_when_security_properties_fail(self):
        item=gateway();item.update(image='unreviewed',restart='always',ports={'8000/tcp':[{'HostIp':'0.0.0.0'}]})
        with patch.object(self.runtime,'inventory',return_value={'api-gw':item}) as inventory, \
             patch.object(self.runtime,'call',side_effect=[b'',b'false']) as call:
            self.runtime.stop()
        inventory.assert_called_once_with(check_gateway=False)
        self.assertEqual(call.call_args_list[0].args[0],self.runtime.base+['stop','--time','30',item['id']])
        self.assertEqual(call.call_args_list[1].args[0][-1],item['id'])

    def test_containment_refuses_foreign_identity_and_unconfirmed_stop(self):
        for key,value in [('name','/other'),('project','foreign'),('service','db'),('id','bad')]:
            item=gateway();item[key]=value
            with self.subTest(key=key),patch.object(self.runtime,'inventory',return_value={'api-gw':item}), \
                 patch.object(self.runtime,'call') as call,self.assertRaises(ValueError):self.runtime.stop()
            call.assert_not_called()
        with patch.object(self.runtime,'inventory',return_value={'api-gw':gateway()}), \
             patch.object(self.runtime,'call',side_effect=[b'',b'true']),self.assertRaises(ValueError):self.runtime.stop()

    def test_status_uses_only_loopback_no_proxy_no_redirect_no_body_output(self):
        response=Mock(status=200);response.__enter__=Mock(return_value=response);response.__exit__=Mock()
        opener=Mock();opener.open.return_value=response
        with patch('dashboard_rotation_runtime.build_opener',return_value=opener) as build:
            self.assertEqual(self.runtime.status(b'tonyaiops',b'synthetic-password'),200)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,'http://127.0.0.1:8000/project/default')
        self.assertTrue(request.get_header('Authorization').startswith('Basic '))
        self.assertEqual(build.call_args.args[0].proxies,{})
        self.assertIsInstance(build.call_args.args[1],NoRedirect)
        self.assertIsNone(NoRedirect().redirect_request(None,None,None,None,None,None))
        response.read.assert_not_called()
        error=HTTPError(request.full_url,302,'redirect',{},io.BytesIO(b'synthetic-secret'))
        with patch('dashboard_rotation_runtime.build_opener',return_value=opener):
            opener.open.side_effect=error
            self.assertEqual(self.runtime.status(),302)

    def test_acceptance_rejects_old_success_missing_denial_redirect_and_failure(self):
        item=gateway();original={'api-gw':dict(item,id='c'*64)}
        for statuses in ([401,401,200],[401,200,200],[200,401,200],[401,401,302],[401,401,503]):
            with self.subTest(statuses=statuses),patch('dashboard_rotation_runtime.read',return_value=self.lock), \
                 patch.object(self.runtime,'require_dependencies'),patch.object(self.runtime,'inventory',return_value={'api-gw':item}), \
                 patch.object(self.runtime,'gateway_environment',return_value={'DASHBOARD_USERNAME':'tonyaiops','DASHBOARD_PASSWORD':'new'}), \
                 patch.object(self.runtime,'status',side_effect=statuses):
                if statuses==[401,401,200]:self.runtime.verify(b'tonyaiops',b'new',b'old',original)
                else:
                    with self.assertRaises(ValueError):self.runtime.verify(b'tonyaiops',b'new',b'old',original)

    def test_private_http_timeout_is_not_acceptance(self):
        opener=Mock();opener.open.side_effect=TimeoutError('synthetic timeout')
        with patch('dashboard_rotation_runtime.build_opener',return_value=opener),self.assertRaises(TimeoutError):
            self.runtime.status(b'tonyaiops',b'synthetic-password')
        self.assertEqual(opener.open.call_args.kwargs['timeout'],10)

    def test_source_lock_and_generated_gateway_must_match_without_regeneration(self):
        upstream=['docker-compose.yml','volumes/api/envoy/docker-entrypoint.sh','volumes/api/envoy/envoy.yaml',
                  'volumes/api/envoy/cds.yaml','volumes/api/envoy/lds.template.yaml']
        files={str(self.runtime.store.runtime/name):b'fixture' for name in upstream}
        template=b'head\n inline_string: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%"\n'
        files[str(self.runtime.store.runtime/'volumes/api/envoy/lds.template.yaml')]=template
        lock={'files':{name:hashlib.sha256(files[str(self.runtime.store.runtime/name)]).hexdigest() for name in upstream}}
        for name in ('selfhost_dashboard_rotation.py','dashboard_rotation_store.py','dashboard_rotation_runtime.py','selfhost_pin.py','compose.qa.yml','compose.https.yml','Caddyfile'):
            files[str(self.runtime.source/name)]=b'fixture'
            if name in ('compose.qa.yml','compose.https.yml','Caddyfile'):files[str(self.runtime.store.runtime/name)]=b'fixture'
        files[str(self.runtime.source/'upstream.lock.json')]=json.dumps(lock).encode()
        files[str(self.runtime.source/'images.qa.lock.json')]=self.lock
        files[str(self.runtime.store.runtime/'compose.images.json')]=self.lock
        derived=self.runtime.store.runtime/'volumes/api/envoy/lds.qa.yaml'
        files[str(derived)]=b'head\n                        inline_string: "%RESPONSE_CODE% %BYTES_RECEIVED% %BYTES_SENT% %DURATION%\\n"\n'
        with patch('dashboard_rotation_runtime.read',side_effect=lambda p:files[str(p)]), \
             patch('dashboard_rotation_runtime.GATEWAY_TEMPLATE_SHA256',hashlib.sha256(template).hexdigest()):
            result=self.runtime.sources();self.assertIn('lds.qa.yaml',result)
            for name in ('docker-compose.yml','compose.qa.yml','compose.images.json','volumes/api/envoy/lds.qa.yaml'):
                path=str(self.runtime.store.runtime/name);original=files[path];files[path]=b'tampered'
                with self.subTest(name=name),self.assertRaises((ValueError,KeyError)):self.runtime.sources()
                files[path]=original


if __name__=='__main__':unittest.main()
