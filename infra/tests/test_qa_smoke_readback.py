"""Real Unit 7 validators with fake Azure command transport, entirely offline."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from qa_application_receipt import manifest
from qa_deployment_contract import accepted_history
from qa_deployment_fixtures import evidence, synthetic_history, NOW, app_data
from qa_smoke_readback import collect, stable
from qa_smoke_contract import bind
from qa_discovery import digest


class SmokeReadbackTests(unittest.TestCase):
    def test_current_web_scale_up_is_not_release_drift_but_other_changes_are(self):
        ev=evidence()
        with synthetic_history(): context=accepted_history(ev, now=NOW)
        before=app_data(context['inputs'],context['revision_names']); after=deepcopy(before)
        after['replicas:tonyai-staging-web--qa001']=['cold-start-replica']
        self.assertEqual(stable(context,before),stable(context,after))
        after['web_app']['properties']['configuration']['ingress']['traffic']=[dict(latestRevision=True,weight=100)]
        self.assertNotEqual(stable(context,before),stable(context,after))
        after=deepcopy(before); after['replicas:tonyai-staging-web--old']=['foreign']
        self.assertNotEqual(stable(context,before),stable(context,after))

    def test_real_oracle_rejects_wrong_region_origin_identity_body_image_and_revision(self):
        ev = evidence()
        with synthetic_history(): context = accepted_history(ev, now=NOW)
        spec = manifest(context['inputs'], ev['unit7']['saved_plan']['plan_sha256'], context['revision_names'], 'after')
        for defect in ('none','region','environment','origin','app-id','image','revision','traffic','config','identity','active-old','missing','command'):
            data = app_data(context['inputs'], context['revision_names'])
            app = data['api_app']; props=app['properties']
            if defect=='region': app['location']='germanywestcentral'
            elif defect=='environment': data['environment']['properties']['vnetConfiguration']['infrastructureSubnetId']='foreign'
            elif defect=='origin': props['configuration']['ingress']['fqdn']='foreign.invalid'
            elif defect=='app-id': app['id'] += '-foreign'
            elif defect=='image': props['template']['containers'][0]['image'] += '-foreign'
            elif defect=='revision': props['latestReadyRevisionName']='tonyai-staging-api--foreign'
            elif defect=='traffic': props['configuration']['ingress']['traffic']=[dict(revisionName='foreign',weight=100)]
            elif defect=='config': props['template']['containers'][0]['env'].append(dict(name='EVIL',value='1'))
            elif defect=='identity': next(iter(app['identity']['userAssignedIdentities'].values()))['principalId']='f'*36
            elif defect=='active-old': data['api_revisions'].append(dict(name='tonyai-staging-api--old',properties=dict(active=True)))
            elif defect=='missing': data['inventory']=[]
            def command(argv):
                if defect=='command': raise SafeFailure('failed command')
                key=next(k for k,v in spec['commands'].items() if v['argv']==argv)
                return data[key]
            with self.subTest(defect=defect), patch('qa_smoke_readback.command',side_effect=command):
                if defect=='none': self.assertEqual(collect(ev,context),data)
                else:
                    with self.assertRaises(SafeFailure): collect(ev,context)

    def test_historical_binding_tampering_rejects_even_rehashed_documents(self):
        for defect in ('source','candidate','digest','release','receipt','plan','draft','origin','foundation'):
            ev=evidence(); unit=ev['unit7']
            if defect=='source': unit['inputs']['release']['source_sha']='f'*40
            elif defect=='candidate': unit['candidate']['lockfile_sha256']='f'*64
            elif defect=='digest': unit['inputs']['release']['api_digest']='sha256:'+'f'*64
            elif defect=='release': unit['inputs']['release']['release_id']='foreign'
            elif defect=='receipt': unit['after_receipt']['revision_names']['api']=['tonyai-staging-api--foreign']
            elif defect=='plan': unit['saved_plan']['resources'][0]['expected_body_sha256']='f'*64
            elif defect=='draft': unit['owner_acceptance']={'status':'BLOCKED_DRAFT','authorization':False}
            elif defect=='origin': unit['inputs']['release']['supabase_origin']='https://evil.invalid'
            elif defect=='foundation': unit['inputs']['foundation']['region']='germanywestcentral'
            with self.subTest(defect=defect), synthetic_history(), self.assertRaises(SafeFailure):
                bind(ev,digest(ev),now=NOW)


if __name__ == '__main__': unittest.main()
