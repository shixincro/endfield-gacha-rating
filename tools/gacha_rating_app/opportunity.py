"""Local first-UP opportunity quote, not a second realized loss or luck score.

Conditional finite DP; no Monte Carlo. Both routes pay to their first target,
exhaust free allowance after early hits, top up UP hits at46..59 to60, and quote their terminal next-banner resources
with the existing fixed water table. Future off-New/extra copies are unpriced.
"""
from functools import lru_cache
import json
import math
from pathlib import Path

VERSION='first-up-terminal-quote-v2-free-floor'
_TABLE=json.loads(Path(__file__).with_name('water_values.json').read_text(encoding='utf-8'))
_WATER={r['pity']:r for r in _TABLE['rows']}
RUSH_UP=1-.996**10
REASONS={
    'free-only-exemption':'未超过免费额度，不计放弃机会。',
    'target-already-obtained':'当期目标已取得，不要求继续追潜。',
    'initial-target-unknown':'期初是否已拥有当期目标未知，机会估值缺项。',
    'ongoing':'本池仍在进行，不结算放弃机会。',
    'source-incomplete':'本池原始记录或资源信息有缺失／冲突，机会估值缺项。',
    'missing-guarantee':'已达120但未见当期目标，需先修正记录。',
    'estimated':'比较本池继续与换池获取首UP的期望净成本；包含终态资源估值，不与资源损耗相加。',
}


def unavailable(reason='source-incomplete'):
    return {'status':'partial','value':None,'reason':reason,'message':REASONS[reason],
            'version':VERSION,'approximate':True}


def p6(n):
    return 1. if n==79 else .008 if n<65 else .008+.05*(n-64)


def terminal_quote(t,n):
    return _WATER[n]['free20' if t>=60 else 'free10']


@lru_cache(maxsize=16384)
def after_hit(t,n,free,topup=True):
    # topup=False keeps raw first-hit semantics for the unchanged water-table
    # check. Production routes apply both free completion and46..59 ->60.
    if not topup or (t>=free and not 46<=t<60):
        return 0.,0.,terminal_quote(t,n)
    chance=p6(n)
    hit=after_hit(t+1,0,free,topup)
    miss=after_hit(t+1,n+1,free,topup) if chance<1 else (0.,0.,0.)
    return (int(t>=free)+chance*hit[0]+(1-chance)*miss[0],
            1+chance*hit[1]+(1-chance)*miss[1],
            chance*hit[2]+(1-chance)*miss[2])


@lru_cache(maxsize=65536)
def first_up(t,n,free,rush_available,topup=True):
    """Expected additional paid/main draws and terminal quote, conditional on state."""
    if not 0<=t<120 or not 0<=n<80 or free not in (0,10,20):
        raise ValueError('invalid first-UP state')
    if rush_available and t>=30:
        hit=after_hit(t,n,free,topup)
        miss=first_up(t,n,free,False,topup)
        return tuple(RUSH_UP*a+(1-RUSH_UP)*b for a,b in zip(hit,miss))
    nxt=t+1
    hit=after_hit(nxt,0,free,topup)
    if nxt==120:
        return int(nxt>free)+hit[0],1+hit[1],hit[2]
    chance=p6(n)
    off=first_up(nxt,0,free,rush_available,topup)
    miss=first_up(nxt,n+1,free,rush_available,topup) if chance<1 else (0.,0.,0.)
    return (int(nxt>free)+chance/2*(hit[0]+off[0])+(1-chance)*miss[0],
            1+chance/2*(hit[1]+off[1])+(1-chance)*miss[1],
            chance/2*(hit[2]+off[2])+(1-chance)*miss[2])


def quote(pool,row,owned_before):
    """Call only after the original pool passed resource/position validation."""
    if row.get('status')=='partial':return unavailable()
    if not row.get('ended'):
        out=unavailable('ongoing');out['status']='provisional';return out
    t=row['total'];free=row['freeAllowance'];n=row.get('actual',{}).get('pity')
    got_up=(owned_before is True or any(e['character']==pool['up'] for e in pool['events'])
            or any(e['character']==pool['up'] for e in pool.get('rush',[])))
    reason='free-only-exemption' if t<=free else 'target-already-obtained' if got_up else None
    if reason:return {'status':'ok','value':0.,'reason':reason,'message':REASONS[reason],
                      'version':VERSION,'approximate':True}
    if owned_before is None:return unavailable('initial-target-unknown')
    if t>=120:return unavailable('missing-guarantee')
    if not isinstance(pool.get('rushUsed'),bool) or n is None:return unavailable()
    try:
        stay=first_up(int(t),int(n),int(free),not pool['rushUsed'])
        switch=first_up(0,int(n),20 if t>=60 else 10,True)
        delta=switch[0]+switch[2]-stay[0]-stay[2]
        if not math.isfinite(delta):return unavailable()
    except (ValueError,KeyError):return unavailable()
    details=lambda values:{'paid':values[0],'mainDraws':values[1],'terminal':values[2],
                           'net':values[0]+values[2]}
    return {'status':'ok','value':max(0.,delta),'signedDifference':delta,
            'stay':details(stay),'switch':details(switch),
            'rawCostDifference':switch[0]-stay[0],'reason':'estimated','message':REASONS['estimated'],
            'version':VERSION,'approximate':True,'method':'conditional-first-UP-DP-plus-fixed-terminal-quote',
            'limitations':'局部首UP机会估值，未单独定价未来歪New或额外潜能，不是全局最优亏损。'}
