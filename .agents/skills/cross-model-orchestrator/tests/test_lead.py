"""Fast merge-safety and attention regression checks. No tmux processes."""

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import load_config, write_json
import lead
import review

SHA = 'a' * 40


class LeadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'state_dir': str(self.root), 'projects': {'owner/repo': {}}, 'lanes': []}
        self.pr = {'state': 'OPEN', 'headRefOid': SHA, 'isDraft': False,
                   'mergeable': 'MERGEABLE', 'statusCheckRollup': [
                       {'name': 'quality', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}]}
        self.directory = review.review_dir(self.config, 'owner/repo', 1)
        self.directory.mkdir(parents=True)
        for reviewer in ('codex', 'claude'):
            (self.directory / f'{reviewer}.md').write_text(f'VERDICT: APPROVE\nCOMMIT: {SHA}\n')
        self.addCleanup(patch.stopall)
        patch.object(lead, 'unresolved_threads', return_value=False).start()
        self.mock_gh = patch.object(lead, 'gh').start()
        self.mock_gh.side_effect = self.gh

    def gh(self, args, **kwargs):
        from types import SimpleNamespace
        if args[0:2] == ['pr', 'diff']:
            return SimpleNamespace(stdout='+portable code\n')
        return SimpleNamespace(stdout=json.dumps(self.pr))

    def test_gate_requires_exact_head_and_latest_top_level_verdicts(self):
        self.assertTrue(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.pr['headRefOid'] = 'b' * 40
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.pr['headRefOid'] = SHA
        (self.directory / 'claude.md').write_text(f'VERDICT: APPROVE\nCOMMIT: {"b" * 40}\n')
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_pending_failure_and_empty_ci_never_merge(self):
        for checks in ([], [{'name': 'x', 'status': 'IN_PROGRESS', 'conclusion': 'SUCCESS'}],
                       [{'context': 'x', 'state': 'PENDING'}],
                       [{'name': 'x', 'status': 'COMPLETED', 'conclusion': 'FAILURE'}]):
            with self.subTest(checks=checks):
                self.pr['statusCheckRollup'] = checks
                self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_path_filtered_checks_pass_and_explicit_required_checks_must_run(self):
        skipped = {'name': 'unaffected', 'status': 'COMPLETED', 'conclusion': 'SKIPPED'}
        self.assertIsNone(lead.check_ci([*self.pr['statusCheckRollup'], skipped]))
        self.assertIsNone(lead.check_ci([skipped]))
        self.assertIsNotNone(lead.check_ci([*self.pr['statusCheckRollup'], skipped], ['unaffected']))

    def test_home_paths_block_without_flagging_detector_source(self):
        self.assertFalse(lead.portability("+~/" + "operator/checkout/file"))
        for root in ("Users", "home"):
            self.assertFalse(lead.portability("+" + "/".join(("", root, "operator", "checkout"))))
        source = Path(lead.__file__).read_text()
        self.assertTrue(lead.portability("\n".join("+" + line for line in source.splitlines())))

    def test_unresolved_or_private_diff_blocks(self):
        with patch.object(lead, 'unresolved_threads', return_value=True):
            self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.config['projects']['owner/repo']['forbidden_patterns'] = ['private-node']
        self.mock_gh.side_effect = lambda args, **kw: type('Result', (), {
            'stdout': '+private-node\n' if args[1] == 'diff' else json.dumps(self.pr)})()
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_dry_run_never_writes_and_execute_requires_allowlist(self):
        report = self.root / 'REPORT.md'
        report.write_text(f'MERGE-READY owner/repo#1 {SHA}\n')
        self.config['lanes'] = [{'report': str(report)}]
        self.assertEqual(lead.merge_watch(self.config)[0]['action'], 'WOULD-MERGE')
        self.assertFalse(any(call.kwargs.get('write') for call in self.mock_gh.mock_calls))
        self.assertEqual(lead.merge_watch(self.config, True)[0]['action'], 'LEAD-MERGE-REQUIRED')
        self.config['projects']['owner/repo']['auto_merge'] = True
        self.config['projects']['owner/repo']['merge_admin'] = True
        self.assertEqual(lead.merge_watch(self.config, True)[0]['action'], 'MERGED')
        call = self.mock_gh.call_args
        self.assertTrue(call.kwargs['write'])
        self.assertIn('--admin', call.args[0])
        self.assertEqual(call.args[0][-2:], ['--match-head-commit', SHA])

    def test_merge_marker_can_be_embedded_but_must_have_full_sha(self):
        report = self.root / 'REPORT.md'
        report.write_text(f'Example MERGE-READY owner/repo#1 {SHA}\nMERGE-READY owner/repo#1 abc1234\n')
        self.config['lanes'] = [{'report': str(report)}]
        self.assertEqual([key for _, key in lead.candidates(self.config)], [('owner/repo', 1, SHA)])

    def test_attention_remembers_id_status_after_timestamp_change_and_recovery(self):
        runs = [{'id': 'r1', 'status': 'blocked', 'statusChangedAt': '2026-10-11T00:00:00Z'}]
        with patch.object(lead, 'project_hook', side_effect=lambda *a: json.dumps({'runs': runs})):
            self.assertEqual(len(lead.run_attention(self.config, 'owner/repo')), 1)
            self.assertEqual(lead.run_attention(self.config, 'owner/repo'), [])
            runs[0]['status'] = 'done'
            self.assertEqual(lead.run_attention(self.config, 'owner/repo'), [])
            runs[0]['status'] = 'blocked'
            runs[0]['statusChangedAt'] = '2026-10-12T00:00:00Z'
            self.assertEqual(lead.run_attention(self.config, 'owner/repo'), [])
            runs[0]['status'] = 'failed'
            self.assertEqual(len(lead.run_attention(self.config, 'owner/repo')), 1)

    def test_vercel_excluded_and_only_configured_repo_can_have_no_ci(self):
        vercel = {'context': 'Vercel', 'state': 'FAILURE'}
        self.assertIsNone(lead.check_ci([*self.pr['statusCheckRollup'], vercel]))
        self.assertEqual(lead.check_ci([vercel]), 'no CI checks present')
        self.pr['statusCheckRollup'] = [vercel]
        self.config['ci'] = {'no_ci_repos': ['other/repo']}
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.config['ci']['no_ci_repos'] = ['owner/repo']
        self.assertTrue(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.pr['statusCheckRollup'].append({'context': 'test', 'state': 'FAILURE'})
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_required_workflows_are_paginated_and_skip_only_relaxes_presence(self):
        self.config['projects']['owner/repo']['required_workflows'] = ['check']
        workflow = {'id': 1, 'name': 'check', 'status': 'completed', 'conclusion': 'success'}
        original = self.gh
        self.mock_gh.side_effect = lambda args, **kw: type('Result', (), {'stdout':
            json.dumps([{'workflow_runs': []}, {'workflow_runs': [workflow]}])
            if args[0] == 'api' else original(args, **kw).stdout})()
        self.assertTrue(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.assertTrue(any('--paginate' in call.args[0] for call in self.mock_gh.call_args_list))
        workflow['conclusion'] = 'skipped'
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        skip = self.root / 'ci-skip.txt'
        skip.write_text('owner/repo\n')
        self.config['ci'] = {'workflow_skip_file': str(skip)}
        self.assertTrue(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        self.pr['statusCheckRollup'][0]['conclusion'] = 'FAILURE'
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_latest_workflow_failure_cannot_inherit_old_success(self):
        checks = self.pr['statusCheckRollup']
        workflows = [{'id': 1, 'name': 'check', 'status': 'completed', 'conclusion': 'success'},
                     {'id': 2, 'name': 'check', 'status': 'completed', 'conclusion': 'failure'}]
        self.assertIsNotNone(lead.check_ci(checks, required_workflows=['check'], workflows=workflows))

    def report(self, text):
        report = self.root / 'REPORT.md'
        report.write_text(text)
        self.config['lanes'] = [{'report': str(report)}]
        return report

    def test_one_merge_per_pass_then_closed_heads_are_suppressed(self):
        self.report(f'MERGE-READY owner/repo#1 {SHA}\nMERGE-READY owner/repo#2 {SHA}\n')
        self.config['projects']['owner/repo']['auto_merge'] = True
        self.assertEqual(len(lead.merge_watch(self.config, True)), 1)
        self.assertEqual(sum(call.args[0][:2] == ['pr', 'merge'] for call in self.mock_gh.call_args_list), 1)
        self.pr['state'] = 'CLOSED'
        self.assertEqual(len(lead.merge_watch(self.config)), 1)
        self.mock_gh.reset_mock()
        self.assertEqual(lead.merge_watch(self.config), [])
        self.mock_gh.assert_not_called()

    def test_conflict_alert_once_per_head_and_does_not_block_other_candidates(self):
        report = self.report(f'MERGE-READY owner/repo#1 {SHA}\n')
        self.pr['mergeable'] = 'CONFLICTING'
        self.assertEqual(lead.merge_watch(self.config, True)[0]['action'], 'CONFLICT')
        self.assertEqual(lead.merge_watch(self.config, True), [])
        report.write_text(f'MERGE-READY owner/repo#1 {"b" * 40}\n')
        self.pr['headRefOid'] = 'b' * 40
        self.assertEqual(lead.merge_watch(self.config, True)[0]['action'], 'CONFLICT')
        self.assertFalse(any(call.kwargs.get('write') for call in self.mock_gh.call_args_list))

    def test_draft_is_readied_only_on_execute_and_head_is_rechecked(self):
        self.report(f'MERGE-READY owner/repo#1 {SHA}\n')
        self.pr['isDraft'] = True
        self.config['projects']['owner/repo']['auto_merge'] = True
        self.assertEqual(lead.merge_watch(self.config)[0]['action'], 'WOULD-MERGE')
        original = self.gh
        def ready(args, **kw):
            if args[:2] == ['pr', 'ready']:
                self.pr['isDraft'] = False
            return original(args, **kw)
        self.mock_gh.side_effect = ready
        self.assertEqual(lead.merge_watch(self.config, True)[0]['action'], 'MERGED')
        writes = [call.args[0][:2] for call in self.mock_gh.call_args_list if call.kwargs.get('write')]
        self.assertEqual(writes, [['pr', 'ready'], ['pr', 'merge']])

    def test_head_change_during_ready_prevents_merge(self):
        self.report(f'MERGE-READY owner/repo#1 {SHA}\n')
        self.pr['isDraft'] = True
        self.config['projects']['owner/repo']['auto_merge'] = True
        original = self.gh
        def changed(args, **kw):
            if args[:2] == ['pr', 'ready']:
                self.pr.update(isDraft=False, headRefOid='b' * 40)
            return original(args, **kw)
        self.mock_gh.side_effect = changed
        self.assertFalse(lead.merge_watch(self.config, True)[0]['ready'])
        self.assertFalse(any(call.args[0][:2] == ['pr', 'merge'] for call in self.mock_gh.call_args_list))

    def test_portability_exclusions_cover_home_paths_guard_lines_and_test_files(self):
        diff = '+// guard prevents /Users/operator/checkout\n'
        exclusions = ['guard', r'(^|/)(tests|examples)/']
        self.assertTrue(lead.portability(diff, ['private-node'], exclusions))
        diff = '+++ b/tests/paths.py\n+p = "/Users/operator/checkout"\n+++ b/src/main.py\n+private-node\n'
        self.assertFalse(lead.portability(diff, ['private-node'], exclusions))
        self.assertTrue(lead.portability(diff.split('+++ b/src')[0], ['private-node'], exclusions))

    def test_legacy_verdicts_read_without_review_state_migration(self):
        legacy = self.root / 'legacy' / 'repo-1'
        legacy.mkdir(parents=True)
        self.config['reviews'] = {'legacy_root': str(legacy.parent)}
        for name in ('codex', 'claude'):
            (legacy / f'{name}.md').write_text(f'VERDICT: APPROVE\nCOMMIT: {SHA}\n')
        (self.directory / 'claude.md').unlink()
        self.assertTrue(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])
        lead.ready(self.config, 'owner/repo', 1, SHA, str(self.root / 'legacy-report.md'))
        self.assertFalse(review.review_state_path(self.config, 'owner/repo', 1).exists())
        write_json(review.review_state_path(self.config, 'owner/repo', 1), {'repo': 'owner/repo', 'pr': 1})
        self.assertFalse(lead.gate(self.config, 'owner/repo', 1, SHA)['ready'])

    def test_heartbeat_discovers_report_prs_and_surfaces_approvals_ci_round_and_hooks(self):
        self.report('PR https://github.com/owner/repo/pull/1\n')
        write_json(review.review_state_path(self.config, 'owner/repo', 1),
                   {'repo': 'owner/repo', 'pr': 1, 'round': 4, 'status': 'needs_changes'})
        project = self.config['projects']['owner/repo']
        project.update(heartbeat_hooks=['machine', 'lock'], mutating_heartbeat_hooks=['machine'],
                       hooks={'nodes': ['nodes'], 'machine': ['awake'], 'lock': ['lock']}, expected_nodes=['one', 'two'])
        def hook(config, repo, name):
            if name == 'nodes':return json.dumps({'nodes': [{'machine': 'one', 'protocolVersion': '1'}], 'gatewayProtocolVersion': '2'})
            raise RuntimeError('lock check failed')
        with patch('lanes.status', return_value=[]), patch.object(lead, 'project_hook', side_effect=hook):
            result = lead.heartbeat(self.config, read_only=True)
        info = result['projects']['owner/repo']
        self.assertEqual(info['missing_nodes'], ['two'])
        self.assertEqual(info['version_mismatches'], ['one'])
        self.assertIn('skipped', info['machine'])
        self.assertIn('error', info['lock'])
        self.assertEqual(result['reviews'][0]['alarm'], 'approved but unmerged')
        (self.directory / 'claude.md').unlink()
        with patch('lanes.status', return_value=[]), patch.object(lead, 'project_hook', side_effect=hook):
            self.assertEqual(lead.heartbeat(self.config, True)['reviews'][0]['alarm'], 'review round >=4')

    def test_attention_legacy_seed_and_complete_context(self):
        seed = self.root / 'seen.txt'
        seed.write_text('old|blocked\n')
        self.config['projects']['owner/repo']['attention_seen_file'] = str(seed)
        runs = [{'id': 'old', 'status': 'blocked'}, {'id': 'new', 'status': 'failed', 'ticketOrPr': 'T-1',
                 'slotId': 's1', 'error': 'worker exited'}, {'id': 'no-time', 'status': 'preparing'}]
        with patch.object(lead, 'project_hook', return_value=json.dumps({'runs': runs})):
            alerts = lead.run_attention(self.config, 'owner/repo')
        self.assertEqual([a['id'] for a in alerts], ['new'])
        self.assertEqual((alerts[0]['ticket'], alerts[0]['slot'], alerts[0]['error']), ('T-1', 's1', 'worker exited'))
        self.assertEqual(seed.read_text(), 'old|blocked\n')

    def test_config_resolves_portable_relative_paths_and_unique_lanes(self):
        path = self.root / 'config.json'
        data = {'version': 1, 'state_dir': 'state', 'lanes': [
            {'id': 'lane-a', 'cwd': '.', 'goal': 'GOAL.md', 'report': 'REPORT.md'}]}
        write_json(path, data)
        config = load_config(path)
        self.assertEqual(config['lanes'][0]['report'], str((self.root / 'REPORT.md').resolve()))
        data['lanes'].append(data['lanes'][0])
        write_json(path, data)
        with self.assertRaises(ValueError):
            load_config(path)


if __name__ == '__main__':
    unittest.main()
