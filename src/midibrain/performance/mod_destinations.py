"""One MOD destination definition, expanded across fixed channels or bank groups."""
from .banks import bank_targets, expanded_channels
from .profile import number


def expand(mod, setup):
    devices = {d['id']: d for d in setup['devices'] if d['kind'] == 'destination'}
    banks = {b['id']: b for b in setup['banks']}
    channels = expanded_channels(setup)
    destinations = mod.get('destinations', [])
    if not isinstance(destinations, list) or len(destinations) > 32:
        raise ValueError('Use up to 32 MOD destinations')
    result = []
    for route in destinations:
        required = {'device', 'parameter', 'channels', 'banks', 'amount', 'scale_by_bank'}
        if not isinstance(route, dict) or not required <= set(route) or set(route) - required - {'min', 'max'}:
            raise ValueError('Invalid MOD destination')
        device = devices.get(route['device'])
        if not device: raise ValueError('MOD destination device is missing')
        if type(route['scale_by_bank']) is not bool: raise ValueError('Bank amount must be on/off')
        number(route['amount'], -1, 1, 'Destination amount')
        lo = number(route.get('min', 0), 0, 127, 'Destination minimum CC', True)
        hi = number(route.get('max', 127), lo, 127, 'Destination maximum CC', True)
        if not isinstance(route['banks'], list) or not isinstance(route['channels'], list): raise ValueError('Choose destination channels or banks')
        if bool(route['banks']) == bool(route['channels']): raise ValueError('Choose fixed channels or bank channels, not both')
        if route['scale_by_bank'] and not route['banks']: raise ValueError('Choose banks to use bank amounts')
        targets, seen = [], set()
        for bid in route['banks']:
            if not isinstance(bid, str) or bid not in banks or bid in seen: raise ValueError('Choose distinct existing banks')
            seen.add(bid); bank = banks[bid]
            if bank['destination'] != route['device']: raise ValueError('Bank belongs to a different destination device')
            targets.extend((cid, bid) for cid in bank_targets(bank, device))
        for cid in route['channels']:
            key = tuple(cid) if isinstance(cid, list) else cid
            # Validate channel references before hashing or looking up.
            from .features import ref_key
            key = ref_key([route['device'], cid, route['parameter']])[1]
            if key in seen: raise ValueError('Duplicate destination channel')
            seen.add(key); targets.append((key, None))
        for cid, bid in targets:
            channel = channels.get((route['device'], cid))
            if channel is None: raise ValueError('Destination channel is not available in this setup')
            parameter = route['parameter']
            if parameter == 'volume':
                param = channel.get('volume')
                if not param: raise ValueError('Volume destination needs a calibrated volume mapping')
                if route['amount'] < 0: raise ValueError('Volume attenuation amount must be positive')
            else:
                param = channel['parameters'].get(parameter)
                if not param or not param.get('continuous', False): raise ValueError('MOD destinations must be smooth parameters')
                if route.get('min', param.get('min', 0)) < param.get('min', 0) or route.get('max', param.get('max', 127)) > param.get('max', 127): raise ValueError('MOD output range must fit the device parameter range')
            local_lo = route.get('min', param.get('min', 0))
            local_hi = route.get('max', param.get('max', 127))
            result.append(dict(ref=[route['device'], list(cid) if isinstance(cid, tuple) else cid, parameter],
                               amount=route['amount'], bank=bid if route['scale_by_bank'] else None,
                               min=local_lo, max=local_hi, address=(device.get('output') or device['id'], param['channel'], param['cc'])))
    return result


def migrate(mod, setup):
    """Preserve legacy MOD routes while presenting a single destination list."""
    import copy
    result = copy.deepcopy(mod)
    result.setdefault('destinations', [])
    banks = {b['id']: b for b in setup['banks']}
    grouped = {}
    for target in result.get('bank_targets', []):
        bank = banks[target['bank']]
        key = bank['destination'], target['parameter']
        route = grouped.setdefault(key, dict(device=key[0], parameter=key[1], channels=[], banks=[], amount=1., scale_by_bank=True))
        route['banks'].append(bank['id'])
    result['destinations'].extend(grouped.values())
    for target in result.get('targets', []):
        result['destinations'].append(dict(device=target['ref'][0], parameter=target['ref'][2], channels=[target['ref'][1]], banks=[], amount=target['amount'], scale_by_bank=False))
    result['targets'] = []; result['bank_targets'] = []
    return result
