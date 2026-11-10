"""Opening collection is state, not fabricated pre-screenshot draw history."""
import copy
import unittest

from importer import BANNERS
from service import score_ledger


def pool(index, total, hits=(), *, initial=0, free=10):
    banner, up = list(BANNERS.items())[index]
    events = [{'at': at, 'character': name, 'source': 'main', 'forced': False}
              for at, name in hits]
    tail = total - events[-1]['at'] if events else (
        total + initial if initial is not None else None)
    rush_used = total >= 30
    return {'id': f'opening-test-{index}', 'index': index, 'banner': banner,
            'up': up, 'total': total, 'initialPity': initial, 'tail': tail,
            'events': events, 'rushUsed': rush_used,
            'rushAt': 30 if rush_used else None, 'rush': [], 'tokens': [],
            'quota': 20 * (total + 10 * rush_used) + 1980 * len(events),
            'ended': True, 'freeAllowance': free, 'issues': []}


def ledger(pools, *, owned=None, initial=0):
    return {'schemaVersion': 'gacha-ledger-v1', 'issues': [], 'weapon': None,
            'character': {'pools': pools, 'initialOwned': owned,
                          'initialPity': initial, 'completeHistory': False,
                          'issues': []}}


class InitialHistoryFlowTests(unittest.TestCase):
    def score_without_mutation(self, data):
        before = copy.deepcopy(data)
        result = score_ledger(data)
        self.assertEqual(data, before)
        return result

    def test_collection_changes_only_new_classification_not_draw_totals(self):
        outputs = []
        for owned in (None, [], ['卡缪']):
            with self.subTest(owned=owned):
                outputs.append(self.score_without_mutation(
                    ledger([pool(8, 70, [(70, '卡缪')])], owned=owned)))
        unknown, new, duplicate = outputs
        self.assertEqual([r['character']['counts']['offNew'] for r in outputs],
                         [None, 1, 0])
        for result in outputs:
            counts = result['character']['counts']
            self.assertEqual((counts['main'], counts['rush'], counts['six'],
                              counts['up'], counts['five']), (70, 1, 1, 0, 0))
            self.assertFalse(result['character']['coverage']['completeHistory'])
        for key in ('characterSix', 'up', 'five'):
            self.assertEqual(unknown['axes'][key]['score'], new['axes'][key]['score'])
            self.assertEqual(new['axes'][key]['score'], duplicate['axes'][key]['score'])
        self.assertNotEqual(new['axes']['limited']['score'],
                            duplicate['axes']['limited']['score'])
        self.assertGreater(new['axes']['limited']['score'],
                           duplicate['axes']['limited']['score'])

    def test_collection_resolves_planning_effective_acquisition(self):
        unknown = self.score_without_mutation(
            ledger([pool(8, 70, [(70, '卡缪')])]))['planning']['pools'][0]
        new = self.score_without_mutation(
            ledger([pool(8, 70, [(70, '卡缪')])], owned=[]))['planning']['pools'][0]
        duplicate = self.score_without_mutation(
            ledger([pool(8, 70, [(70, '卡缪')])], owned=['卡缪']))['planning']['pools'][0]
        self.assertEqual(unknown['status'], 'partial')
        self.assertEqual(unknown['unknownNewPositions'], [70])
        self.assertIsNone(unknown['localLoss'])
        self.assertEqual(new['status'], 'ok')
        self.assertEqual(new['anchor']['kind'], 'new-limited')
        self.assertEqual(new['anchor']['character'], '卡缪')
        self.assertEqual(new['idealStop'], 70)
        self.assertEqual(new['localLoss'], 0)
        self.assertEqual(duplicate['status'], 'ok')
        self.assertEqual(duplicate['newLimitedHits'], [])
        self.assertEqual(duplicate['idealStop'], 10)
        self.assertGreater(duplicate['localLoss'], 0)

    def test_late_first_account_pool_has_zero_pity_and_ten_free_draws(self):
        data = ledger([pool(8, 10, [(7, '诀')], initial=0, free=10)],
                      owned=[], initial=0)
        result = self.score_without_mutation(data)
        row = result['planning']['pools'][0]
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['freeAllowance'], 10)
        self.assertEqual(row['freeSource'], 'explicit')
        self.assertEqual(row['idealStop'], 10)
        self.assertEqual(row['actual']['permanent'], 0)
        self.assertEqual(result['character']['coverage']['initialPity'], 0)
        self.assertEqual(result['axes']['characterSix']['details']['excludedOpeningSegments'], [])

    def test_returning_account_opening_pity_and_twenty_free_draws(self):
        data = ledger([pool(8, 20, [(15, '诀')], initial=23, free=20)],
                      owned=['卡缪'], initial=23)
        result = self.score_without_mutation(data)
        row = result['planning']['pools'][0]
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['freeAllowance'], 20)
        self.assertEqual(row['freeSource'], 'explicit')
        self.assertEqual(row['idealStop'], 20)
        self.assertEqual(row['actual']['permanent'], 0)
        self.assertEqual(row['actual']['pity'], 5)
        self.assertEqual(result['character']['counts']['main'], 20)
        self.assertEqual(result['character']['counts']['six'], 1)
        self.assertEqual(result['character']['coverage']['initialPity'], 23)
        self.assertEqual(result['axes']['characterSix']['details']['excludedOpeningSegments'], [])

    def test_confirmed_opening_does_not_bridge_missing_middle_pool(self):
        data = ledger([
            pool(8, 10, [(10, '诀')]),
            pool(10, 20, [(20, '梨诺')], initial=None),
        ], owned=[])
        result = self.score_without_mutation(data)
        self.assertFalse(result['character']['coverage']['completeHistory'])
        excluded = result['axes']['characterSix']['details']['excludedOpeningSegments']
        self.assertEqual(len(excluded), 1)
        self.assertEqual(excluded[0]['reason'], 'unknown-opening-pity')
        self.assertEqual(excluded[0]['draws'], 20)
        self.assertEqual(excluded[0]['pool'], 'opening-test-10')
        row = result['planning']['pools'][1]
        self.assertEqual(row['status'], 'partial')
        self.assertIsNone(row['localLoss'])

    def test_missing_middle_pool_keeps_new_unknown_even_with_known_pity(self):
        data = ledger([
            pool(8, 10, [(10, '诀')]),
            pool(10, 20, [(20, '梨诺')], initial=0),
        ], owned=[])
        result = self.score_without_mutation(data)
        self.assertIsNone(result['character']['counts']['offNew'])
        identities = result['axes']['limited']['details']['identities']
        second = next(row for row in identities if row['pool'] == 'opening-test-10')
        self.assertEqual(second['missing'], 0)
        self.assertEqual(second['weight'], 1)
        self.assertEqual(result['axes']['characterSix']['details']['excludedOpeningSegments'], [])
        row = result['planning']['pools'][1]
        self.assertEqual(row['status'], 'partial')
        self.assertEqual(row['unknownNewPositions'], [20])
        self.assertIsNone(row['localLoss'])

    def test_explicit_complete_history_can_bridge_zero_draw_banner_gap(self):
        data = ledger([
            pool(8, 10, [(10, '诀')]),
            pool(10, 20, [(20, '梨诺')], initial=0),
        ], owned=[])
        data['character']['completeHistory'] = True
        result = self.score_without_mutation(data)
        self.assertEqual(result['character']['counts']['offNew'], 1)
        identities = result['axes']['limited']['details']['identities']
        second = next(row for row in identities if row['pool'] == 'opening-test-10')
        self.assertEqual(second['missing'], 1)
        self.assertEqual(second['weight'], 2)
        row = result['planning']['pools'][1]
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['anchor']['kind'], 'new-limited')
        self.assertEqual(row['idealStop'], 20)

    def test_preowned_target_resolves_opportunity_without_adding_output(self):
        result = self.score_without_mutation(
            ledger([pool(8, 30)], owned=['诀']))
        counts = result['character']['counts']
        self.assertEqual((counts['main'], counts['six'], counts['up']), (30, 0, 0))
        opportunity = result['planning']['pools'][0]['opportunity']
        self.assertEqual(opportunity['value'], 0)
        self.assertEqual(opportunity['reason'], 'target-already-obtained')


if __name__ == '__main__':
    unittest.main()
