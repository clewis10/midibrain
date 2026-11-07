"""Rewrite a rig so strip "MOD amount" knobs are Scale operators.

Older rigs duck volume with a per-strip amount: the MOD's ``bank_targets`` plus a strip knob
mapped to the reserved ``depth`` parameter. The same behaviour is expressible with the
operator node: ``MOD → Scale (Amount ← that knob) → channel volume``. This converts one into
the other without changing what you hear: the operator starts at the strip's current amount
and follows the knob once it moves. Strips whose knob is missing keep their old route.
"""
import copy

from .banks import MOD_PARAMETERS
from .operators import default_operator


def sidechain_to_operators(profile):
    """Return a new profile with one Scale operator per strip that has a MOD amount knob."""
    from .bank_engine import BankEngine
    engine = BankEngine(copy.deepcopy(profile), lambda message: None)
    result = engine.settings_profile()
    setup, config = result['bank_setup'], copy.deepcopy(engine.features.config)
    banks = {bank['id']: bank for bank in setup['banks']}
    devices = {device['id']: device for device in setup['devices']}
    operators = config.setdefault('operators', [])
    for mod_index, mod in enumerate(config['mods']):
        slot = {index: name for name, index in MOD_PARAMETERS.items()}[min(mod_index, 2)] if mod_index < 3 else None
        if slot is None: continue
        kept = []
        for target in mod['bank_targets']:
            bank = banks[target['bank']]
            if target['parameter'] != 'volume':
                kept.append(target); continue
            knob = next(((control_index, layer, binding) for control_index, control in enumerate(bank['controls']) for layer, binding in control.items()
                         if binding.get('parameter') == slot and binding.get('source')), None)
            if knob is None:
                kept.append(target); continue
            _, _, binding = knob
            controller = devices[bank['controller']]
            amount = bank.get('depth', 0.) if mod_index == 0 else bank.get('mod_depths', [0., 0., 0.])[mod_index]
            operator = default_operator(len(operators), 'scale')
            operator.update(name=f"{bank['name']} {mod['name']} amount", inputs=[{'type': 'mod', 'index': mod_index}])
            operator['params']['amount'] = float(amount)
            operator['links'] = {'amount': {'controller': controller['id'], 'channel': binding['source']['channel'], 'number': binding['source']['cc']}}
            # Driving the strip itself: the operator follows whichever channels the strip broadcasts to.
            operator['targets'] = [dict(device=bank['destination'], parameter='volume', channels=[], banks=[bank['id']], amount=1.0, scale_by_bank=False)]
            operators.append(operator)
            # The knob stays on its strip, now a plain labelled control that only feeds the operator.
            binding['parameter'] = None
            binding['feedback'] = None
            binding.setdefault('label', f'{mod["name"]} amt')
        mod['bank_targets'] = kept
    result['bank_setup'], result['performance'] = setup, config
    return result
