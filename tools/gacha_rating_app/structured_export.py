"""Source-format normalization, separate from scoring and source summaries."""
from collections import Counter


def split_weapon_records(ordered_rows, up):
    """Separate draws from rewards, preserving the original rows as evidence.

    Some v3 exports omit specialType for weapon milestones and label them as
    rarity 4. Infer only an extra eleventh result in a ten-draw batch at the
    matching milestone; a weapon name or rarity alone never proves a gift.
    Input must be in chronological source order and start at the pool opening.
    """
    batch_sizes = Counter(r.get('batchId') for r in ordered_rows)
    last_in_batch = {r.get('batchId'):i for i,r in enumerate(ordered_rows)}
    batch_seen = Counter()
    pulls, gifts = [], []
    for i,row in enumerate(ordered_rows):
        batch = row.get('batchId')
        batch_seen[batch] += 1
        at = len(pulls)
        kind = None
        method = None
        if row.get('specialType') == 'gift':
            kind, method = 'explicit-gift', 'source-specialType'
        elif (batch and batch_sizes[batch] == 11 and batch_seen[batch] == 11
              and last_in_batch[batch] == i and not row.get('isFree')):
            name = row.get('name','')
            if name.startswith('补充武库箱') and at >= 100 and (at-100) % 160 == 0:
                kind = 'weapon-supply-box'
            elif name == up and at >= 180 and (at-180) % 160 == 0:
                kind = 'milestone-signature'
            if kind:
                method = 'milestone-plus-extra-eleventh-batch-record'
        if kind:
            gifts.append({'at':at,'name':row.get('name'),'sourceId':row.get('id'),
                          'rewardKind':kind,'classificationMethod':method,
                          'sourceRow':dict(row)})
        else:
            pulls.append(row)
    return pulls, gifts
