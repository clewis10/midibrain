"""Reusable, explicit routing additions for the known performance rig."""
import copy

from .routing import empty_routing


def fresh_profile():
    from .features import defaults
    from .profile import demo_profile
    profile = demo_profile()
    profile.update(rig_name='Untitled patch', controller_inputs_migrated=True,
                   bank_setup=dict(devices=[], banks=[], resets=[]), routing=empty_routing())
    profile['performance'] = defaults()
    profile['performance']['mods'] = []
    return profile


def twister_page2(profile, output):
    result = copy.deepcopy(profile)
    source = result['ports']['twister_input']
    def keep(binding):
        return not (binding.get('channel') == 4 and binding.get('cc', binding.get('number')) == 12
                    and binding.get('controller', 'twister') == 'twister')
    result['twister']['resets'] = [binding for binding in result['twister']['resets'] if keep(binding)]
    setup = result.get('bank_setup')
    if setup:
        setup['resets'] = [binding for binding in setup['resets'] if keep(binding)]
        controller = next(device for device in setup['devices'] if device['id'] == 'twister')
        controller['pages'] = list(dict.fromkeys([*controller.get('pages', ['Page 1']), 'Page 2']))
        controller['layers'] = list(dict.fromkeys([*controller.get('layers', ['normal', 'alternate'] if controller.get('alternate') else ['normal']), 'page2']))
        controller.setdefault('layer_types', {})['page2'] = 'direct'
    if 'performance' in result:
        result['performance']['actions'] = [binding for binding in result['performance']['actions'] if keep(binding)]
    routes = result.setdefault('routing', empty_routing())['cc']
    for index in range(16):
        route = dict(source=source, channel=1, cc=16 + index, page='Page 2',
                     destinations=[dict(port=output, channel=16, cc=70 + index)])
        if setup: route.update(controller='twister', layer='page2')
        previous = next((item for item in routes if (item['source'], item['channel'], item['cc']) == (source, 1, 16 + index)), None)
        if previous is not None:
            comparable = {key: value for key, value in previous.items() if key not in ('page', 'controller', 'layer')}
            if comparable != {key: value for key, value in route.items() if key not in ('page', 'controller', 'layer')}:
                raise ValueError(f'Existing route for page 2 knob {index + 1}; refusing to overwrite it')
            previous.setdefault('page', 'Page 2')
            if setup: previous.update(controller='twister', layer='page2')
        else:
            routes.append(route)
    return result
