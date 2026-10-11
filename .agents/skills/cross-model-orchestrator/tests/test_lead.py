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

    def test_path_filtered_checks_need_a_success_and_required_checks_must_run(self):
        skipped = {'name': 'unaffected', 'status': 'COMPLETED', 'conclusion': 'SKIPPED'}
        self.assertIsNone(lead.check_ci([*self.pr['statusCheckRollup'], skipped]))
        self.assertIsNotNone(lead.check_ci([skipped]))
        self.assertIsNotNone(lead.check_ci([*self.pr['statusCheckRollup'], skipped], ['unaffected']))

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

    def test_merge_marker_must_be_full_line_full_sha(self):
        report = self.root / 'REPORT.md'
        report.write_text(f'Example MERGE-READY owner/repo#1 {SHA}\nMERGE-READY owner/repo#1 abc1234\n')
        self.config['lanes'] = [{'report': str(report)}]
        self.assertEqual(list(lead.candidates(self.config)), [])

    def test_attention_reports_changes_and_rearms_after_recovery(self):
        runs = [{'id': 'r1', 'status': 'blocked', 'statusChangedAt': '2026-10-11T00:00:00Z'}]
        with patch.object(lead, 'project_hook', side_effect=lambda *a: json.dumps({'runs': runs})):
            self.assertEqual(len(lead.run_attention(self.config, 'owner/repo')), 1)
            self.assertEqual(lead.run_attention(self.config, 'owner/repo'), [])
            runs[0]['status'] = 'done'
            self.assertEqual(lead.run_attention(self.config, 'owner/repo'), [])
            runs[0]['status'] = 'blocked'
            self.assertEqual(len(lead.run_attention(self.config, 'owner/repo')), 1)

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
