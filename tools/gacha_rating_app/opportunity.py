"""Local stop-state opportunity quote, not a second realized loss or luck score.

Both stages compare the expected additional paid draws from the actual stop
with the steady cost per flat-policy UP, adjusted for the pity kept by stopping.
"""
from functools import lru_cache
import json
import math
from pathlib import Path

VERSION='opportunity-flat-benchmark-water-v6'
_TABLE=json.loads(Path(__file__).with_name('water_values.json').read_text(encoding='utf-8'))
_WATER={r['pity']:r for r in _TABLE['rows']}
RUSH_UP=1-.996**10
FIRST_UP=120
TOKEN_INTERVAL=240
FULL_POTENTIAL_COPIES=6
# launch_stop_when_owned in outputs/zero_flat_steady_corrected_exact.csv:
# steady permanent cost per banner, stop after first UP and the remaining free draws.
FLAT_FIRST_UP_PAID=61.85788564745958
REASONS={
    'free-only-exemption':'未超过免费额度，不计放弃机会。',
    'main-up-already-obtained':'本池已出主池 UP，首个 120 保底已结束。',
    'target-full-potential':'当期 UP 已确认满潜，不再计算信物阶段的机会亏损。',
    'ongoing':'本池仍在进行，不结算放弃机会。',
    'source-incomplete':'本池原始记录或资源信息有缺失／冲突，机会亏损缺项。',
    'estimated':'用平铺成本减去继续本池拿 UP 的期望追加永久抽，以及停手保留水位的预计省抽。',
    'token-vs-flat':'按自然 UP 或下一次信物先到计算追加永久抽，与扣除保留水位价值后的平铺成本相比。',
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
    # Stop at the first hit when quoting only the cost of reaching an UP.
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


@lru_cache(maxsize=TOKEN_INTERVAL*80)
def paid_to_up_or_token(remaining,n):
    """Expected paid draws until a natural main UP or the next token."""
    if remaining==1:
        return 1.
    chance=p6(n)
    off=paid_to_up_or_token(remaining-1,0)
    miss=paid_to_up_or_token(remaining-1,n+1) if chance<1 else 0.
    return 1+chance/2*off+(1-chance)*miss


def quote(pool,row,known_target_copies):
    """Call only after the original pool passed resource/position validation."""
    if row.get('status')=='partial':return unavailable()
    if not row.get('ended'):
        out=unavailable('ongoing');out['status']='provisional';return out
    t=row['total'];free=row['freeAllowance'];n=row.get('actual',{}).get('pity')
    token_stage=t>=FIRST_UP
    reason=None
    if t<=free:
        reason='free-only-exemption'
    elif token_stage and known_target_copies>=FULL_POTENTIAL_COPIES:
        reason='target-full-potential'
    elif not token_stage and any(hit['character']==pool['up'] for hit in pool['events']):
        reason='main-up-already-obtained'
    if reason:return {'status':'ok','value':0.,'reason':reason,'message':REASONS[reason],
                      'version':VERSION,'approximate':True}
    if not isinstance(pool.get('rushUsed'),bool) or n is None:return unavailable()
    try:
        deadline=(t//TOKEN_INTERVAL+1)*TOKEN_INTERVAL if token_stage else FIRST_UP
        if token_stage:
            stay_paid=stay_draws=paid_to_up_or_token(deadline-t,int(n))
            reason='token-vs-flat'
            method='natural-up-or-token-dp-vs-flat-paid'
        else:
            stay_paid,stay_draws,_=first_up(int(t),int(n),int(free),not pool['rushUsed'],topup=False)
            reason='estimated'
            method='first-up-dp-vs-flat-paid'
        # Hold next-banner free allowance fixed so only the retained pity is
        # valued here, without crediting the #60 voucher a second time.
        water_saving=terminal_quote(t,0)-terminal_quote(t,int(n))
        cost_difference=FLAT_FIRST_UP_PAID-stay_paid
        delta=cost_difference-water_saving
        if not math.isfinite(delta):return unavailable()
    except (ValueError,KeyError):return unavailable()
    return {'status':'ok','value':max(0.,delta),'signedDifference':delta,
            'stay':{'paid':stay_paid,'mainDraws':stay_draws},
            'benchmark':{'paid':FLAT_FIRST_UP_PAID,'strategy':'flat-first-up-free-finish'},
            'rawCostDifference':cost_difference,'waterSaving':water_saving,
            'reason':reason,'message':REASONS[reason],
            'version':VERSION,'approximate':True,'method':method,'deadline':deadline}
