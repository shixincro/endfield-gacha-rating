"""Unknown cards stay isolated; title selection never drops source evidence."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from importer import (augment_pools, attach_pool_image_evidence, build_ledger, issue,
                      revalidate_current_ledger)


def hit(pulls, name, crop, *, off=False, review='banner_identity_unknown', accepted=True):
    return {'pulls':pulls, 'pity':None, 'character':name, 'identitySource':'avatar',
            'raw_text':str(pulls)+'抽', 'crop':crop, 'off':None, 'offBadgeObserved':off,
            'needs_review':review, 'avatar_match':{'character':name, 'needs_review':not accepted},
            'avatar_location':{'needs_review':False}}


def fixture():
    unknown = {'banner':None, 'banner_raw':'熔业约痘01日22口-02日07口', 'cardId':'card-6567',
               'cardBoundary':{'startY':6542, 'endY':7100, 'totalY':6567},
               'header_raw':'合计122抽垫2产出10200', 'total':122, 'tail':2, 'tail_known':True, 'quota':10200,
               'events':[hit(49,'莱万汀','/data/source/crops/49.png'), hit(71,'伊冯','/data/source/crops/71.png',off=True)],
               'rush':[], 'rushUsed':True, 'rushAt':30, 'rush_present':True,
               'rush_no_six':{'pulls':10, 'kind':'no_six'}, 'token_count':0,
               'needs_review':['banner_identity_unknown', 'event_needs_review'],
               'issues':[issue('banner_identity_unknown','标题未知','error'), issue('event_needs_review','原卡出货待审','error')],
               'evidence':{'crop':'/data/source/pool.png'}}
    known = {'banner':'轻飘飘的信使', 'total':76, 'tail':4, 'tail_known':True, 'quota':5500,
             'events':[dict(hit(72,'洁尔佩塔','/data/source/crops/72.png',review=None), pity=2)],
             'rush':[], 'rushUsed':True, 'rushAt':30, 'token_count':0, 'issues':[]}
    doc = {'file':'unknown-card.png', 'source_sha256':'source-a', 'sourceImage':'/data/source/source.png',
           'kind':'character', 'identity':{'uid':'12345678'}, 'pools':[known,unknown], 'issues':[],
           'overview':{'character':{'N':198, 'K6':3, 'off':1}}}
    return [doc], build_ledger([doc])


def bind(ledger):
    card = ledger['unresolvedCards'][0]
    pool = {key:copy.deepcopy(card[key]) for key in ('total','tail','localTail','quota','events','rush','rushUsed','rushAt','tokens','evidence')}
    pool.update(id='manual-banner-0', banner='熔火灼痕', index=0, up='莱万汀', initialPity=0, issues=[])
    pool['evidence'].update(manual=True, unresolvedCardId=card['id'])
    ledger['character']['pools'].insert(0, pool)
    ledger['character'].update(initialPity=0, initialOwned=[], completeHistory=True, historyEvidence='manual-banner-coverage')
    return pool


def root_unknown(ledger):
    return [entry for entry in ledger['issues'] if entry['code']=='unrecognized_pool_card']


class UnknownCardTests(unittest.TestCase):
    def test_unknown_card_is_retained_with_events_and_not_counted_as_neighbor_rush(self):
        documents, ledger = fixture()
        self.assertEqual(len(ledger['character']['pools']), 1)
        self.assertEqual(ledger['character']['pools'][0]['rush'], [])
        self.assertEqual(len(ledger['unresolvedCards']), 1)
        card = ledger['unresolvedCards'][0]
        self.assertEqual(card['id'], 'source-a:card-6567')
        self.assertEqual([event['at'] for event in card['events']], [71,120])
        self.assertEqual([event['character'] for event in card['events']], ['伊冯','莱万汀'])
        self.assertTrue(root_unknown(ledger))
        card['events'][0]['evidence']['avatar']['character'] = 'edited copy'
        self.assertEqual(documents[0]['pools'][1]['events'][1]['avatar_match']['character'], '伊冯')

    def test_bound_complete_card_resolves_only_title_and_reconstructs_120(self):
        documents, ledger = fixture()
        original = copy.deepcopy(documents)
        bind(ledger)
        with patch('importer._prototype', side_effect=AssertionError('must not OCR')):
            checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(root_unknown(checked))
        self.assertFalse(checked['issues'])
        self.assertEqual(checked['character']['pools'][0]['issues'], [])
        self.assertTrue(checked['character']['pools'][0]['events'][1]['forced'])
        self.assertEqual(len(checked['unresolvedCards']), 1)
        self.assertEqual(documents, original)

    def test_removing_bound_manual_pool_restores_unresolved_card(self):
        documents, ledger = fixture()
        bind(ledger)
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        checked['character']['pools'] = checked['character']['pools'][1:]
        checked['character'].update(initialPity=None, initialOwned=None, completeHistory=False)
        reopened = revalidate_current_ledger(documents, checked, reviewed=True)
        self.assertTrue(root_unknown(reopened))
        self.assertEqual(reopened['unresolvedCards'][0]['id'], ledger['unresolvedCards'][0]['id'])

    def test_empty_partial_duplicate_and_cross_source_bindings_do_not_waive_real_rows(self):
        for mode in ('empty', 'partial', 'duplicate', 'wrong-source'):
            documents, ledger = fixture()
            pool = bind(ledger)
            if mode == 'empty':
                pool['events'] = []
            elif mode == 'partial':
                pool['events'].pop()
            elif mode == 'duplicate':
                pool['events'].append(copy.deepcopy(pool['events'][0]))
            else:
                pool['evidence']['source_sha256'] = 'wrong-source'
            with self.subTest(mode=mode):
                checked = revalidate_current_ledger(documents, ledger, reviewed=True)
                self.assertTrue(root_unknown(checked))

    def test_choosing_banner_does_not_clear_low_confidence_avatar(self):
        documents, _ = fixture()
        documents[0]['pools'][1]['events'][0]['avatar_match']['needs_review'] = True
        ledger = build_ledger(documents)
        bind(ledger)
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(root_unknown(checked))
        issues = checked['character']['pools'][0]['issues']
        self.assertTrue(any(entry['code']=='event_needs_review' for entry in issues))

    def test_stable_event_ids_work_without_crops_or_distinct_ocr_text(self):
        documents, _ = fixture()
        unknown = documents[0]['pools'][1]
        unknown.update(total=10, tail=0, quota=4160, rushUsed=False, rushAt=None, rush_present=False,
                       events=[hit(5,'莱万汀',None),hit(5,'莱万汀',None)])
        documents[0]['overview'] = {}
        ledger = build_ledger(documents)
        bind(ledger)
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        self.assertFalse(root_unknown(checked))
        self.assertFalse(any(entry['code']=='event_needs_review' for entry in checked['character']['pools'][0]['issues']))

    def test_same_card_position_in_two_images_does_not_collide(self):
        documents, _ = fixture()
        other = copy.deepcopy(documents[0])
        other['source_sha256'] = 'source-b'
        ledger = build_ledger(documents+[other])
        self.assertEqual({card['id'] for card in ledger['unresolvedCards']}, {'source-a:card-6567','source-b:card-6567'})

    def test_old_rush_with_saved_49_or_71_intervals_is_flagged_until_removed(self):
        documents, _ = fixture()
        old = documents[0]['pools'][0]
        old['rush'] = [hit(49,'莱万汀','/data/source/49.png',review=None), hit(71,'伊冯','/data/source/71.png',off=True,review=None)]
        documents[0]['pools'] = [old]
        ledger = build_ledger(documents)
        ledger['character']['pools'][0]['quota'] = 9999
        checked = revalidate_current_ledger(documents, ledger, reviewed=True)
        pool = checked['character']['pools'][0]
        conflicts = [entry for entry in pool['issues'] if entry['code']=='rush_interval_exceeds_10']
        self.assertEqual({entry['interval'] for entry in conflicts}, {49,71})
        self.assertEqual(pool['quota'], 9999)
        pool['rush'] = []
        fixed = revalidate_current_ledger(documents, checked, reviewed=True)
        self.assertFalse(any(entry['code']=='rush_interval_exceeds_10' for entry in fixed['character']['pools'][0]['issues']))

    def test_quota_uses_total_anchor_when_title_text_is_unreadable(self):
        documents, _ = fixture()
        raw = documents[0]['pools'][1]
        raw['banner_raw'] = ''
        rows = [{'text':'合计122抽垫2产出10200', 'x':275, 'y':6567, 'box':[74,6551,476,6583]}]
        augmented = augment_pools([raw], rows)[0]
        self.assertEqual(augmented['quota'], 10200)
        self.assertEqual(augmented['tail'], 2)

    def test_unknown_title_boundary_still_gets_isolated_panel_crop(self):
        with tempfile.TemporaryDirectory(prefix='unknown-card-', dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            source = root/'source.png'
            Image.new('RGB', (1000,1000), '#abcdee').save(source)
            pools = [{'banner':'轻飘飘的信使', 'banner_raw':'known', 'cardBoundary':{'startY':100,'endY':500,'totalY':150}},
                     {'banner':None, 'banner_raw':'', 'cardBoundary':{'startY':500,'endY':1000,'totalY':550}}]
            attach_pool_image_evidence(pools, [], source, root/'panels')
            self.assertEqual(pools[0]['evidence']['box'], [0,65,1000,465])
            self.assertEqual(pools[1]['evidence']['box'], [0,465,1000,1000])
            self.assertTrue(Path(pools[1]['evidence']['crop']).is_file())


if __name__ == '__main__':
    unittest.main()
