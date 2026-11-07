"""Operators: small math/logic nodes that sit between signals and destinations.

A signal is a number, normally -1..1 (MODs are bipolar, a knob is 0..1). An operator
takes any number of input signals (MOD outputs, knobs, other operators), applies one
function and produces one output signal. The output drives destination parameters the
same way a MOD does (``targets`` use the MOD destination format), or feeds another
operator. Operators never touch MIDI directly: the performance engine adds their
output to the same per-address contributions it already sums for MODs.

Parameters can follow a knob (``links``: parameter name -> controller CC), which is how
"this knob sets the most a MOD can send" is expressed.
"""
import math

MAX_OPERATORS = 32
MAX_INPUTS = 16

# kind -> (label, {parameter: (default, low, high)}).  Parameters are numbers; some
# kinds are stateful (smooth) or discrete (steps, mode).
KINDS = {
    'sum': ('Sum', {'gain': (1., -4., 4.)}),
    'average': ('Average', {}),
    'multiply': ('Multiply', {}),
    'min': ('Minimum', {}),
    'max': ('Maximum', {}),
    'scale': ('Scale / limit', {'amount': (1., 0., 1.), 'offset': (0., -1., 1.)}),
    'invert': ('Invert', {}),
    'abs': ('Absolute', {}),
    'curve': ('Curve', {'curve': (0., -1., 1.)}),
    'quantize': ('Quantize', {'steps': (8., 2., 64.), 'scale': (0., 0., 13.), 'root': (0., 0., 11.)}),
    'smooth': ('Smooth', {'time_ms': (200., 1., 10000.)}),
    'threshold': ('Threshold (gate)', {'level': (.5, -1., 1.)}),
    'and': ('AND', {}),
    'or': ('OR', {}),
    'xor': ('XOR', {}),
    'not': ('NOT', {}),
}
# Scales for quantize (semitone offsets); index 0 means "plain steps".
SCALES = [None, (0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10), (0, 2, 3, 5, 7, 9, 10), (0, 1, 3, 5, 7, 8, 10), (0, 2, 4, 6, 7, 9, 11),
          (0, 2, 4, 5, 7, 9, 10), (0, 1, 3, 5, 6, 8, 10), (0, 2, 3, 5, 7, 8, 11), (0, 2, 3, 5, 7, 9, 11),
          (0, 2, 4, 7, 9), (0, 3, 5, 7, 10), (0, 3, 5, 6, 7, 10), (0, 2, 4, 6, 8, 10)]
SCALE_NAMES = ['steps', 'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonic minor', 'melodic minor',
               'pentatonic major', 'pentatonic minor', 'blues', 'whole tone']
# Operators that need exactly one input / any number of inputs.
UNARY = {'scale', 'invert', 'abs', 'curve', 'quantize', 'smooth', 'threshold', 'not'}


def defaults_for(kind):
    return {name: spec[0] for name, spec in KINDS[kind][1].items()}


def default_operator(index, kind='scale'):
    return dict(name=f'{KINDS[kind][0]} {index + 1}', kind=kind, params=defaults_for(kind), inputs=[], links={}, targets=[])


def _number(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label} must be a number in {low}..{high}')
    return value


def validate(operators, mod_count, controllers, graph_check=True):
    """Check the operator list. ``controllers`` is the set of controller ids (for knob inputs/links)."""
    if not isinstance(operators, list) or len(operators) > MAX_OPERATORS:
        raise ValueError(f'Use up to {MAX_OPERATORS} operators')
    edges = {}
    for index, op in enumerate(operators):
        required = {'name', 'kind', 'params', 'inputs', 'links', 'targets'}
        if not isinstance(op, dict) or set(op) != required:
            raise ValueError('Invalid operator')
        if not isinstance(op['name'], str) or not 1 <= len(op['name']) <= 80:
            raise ValueError('Operator name must be 1..80 characters')
        if op['kind'] not in KINDS:
            raise ValueError('Unknown operator kind')
        spec = KINDS[op['kind']][1]
        if not isinstance(op['params'], dict) or set(op['params']) - set(spec):
            raise ValueError('Invalid operator settings')
        for name, value in op['params'].items():
            _number(value, spec[name][1], spec[name][2], name)
        if not isinstance(op['links'], dict) or set(op['links']) - set(spec):
            raise ValueError('A knob can only set an operator setting that exists')
        for link in op['links'].values():
            _knob(link, controllers)
        if not isinstance(op['inputs'], list) or len(op['inputs']) > MAX_INPUTS:
            raise ValueError(f'An operator takes up to {MAX_INPUTS} inputs')
        seen = set()
        for source in op['inputs']:
            if not isinstance(source, dict) or source.get('type') not in ('mod', 'op', 'cc'):
                raise ValueError('Invalid operator input')
            if source['type'] == 'mod':
                if set(source) != {'type', 'index'} or type(source['index']) is not int or not 0 <= source['index'] < mod_count:
                    raise ValueError('Operator input refers to a missing MOD')
                key = ('mod', source['index'])
            elif source['type'] == 'op':
                if set(source) != {'type', 'index'} or type(source['index']) is not int or not 0 <= source['index'] < len(operators) or source['index'] == index:
                    raise ValueError('Operator input refers to a missing operator')
                key = ('op', source['index'])
                edges.setdefault(index, set()).add(source['index'])
            else:
                _knob(source, controllers, extra={'type'})
                key = ('cc', source['controller'], source['channel'], source['number'])
            if key in seen:
                raise ValueError('The same signal is wired to this operator twice')
            seen.add(key)
        if not isinstance(op['targets'], list):
            raise ValueError('Invalid operator destinations')
    if graph_check:
        order(len(operators), edges)


def _knob(link, controllers, extra=()):
    if not isinstance(link, dict) or set(link) != {'controller', 'channel', 'number'} | set(extra):
        raise ValueError('A knob link needs a controller, channel and CC')
    if link['controller'] not in controllers:
        raise ValueError('Operator knob refers to a missing controller')
    _number(link['channel'], 1, 16, 'Knob channel')
    _number(link['number'], 0, 119, 'Knob CC')
    if type(link['channel']) is not int or type(link['number']) is not int:
        raise ValueError('Knob channel and CC must be whole numbers')


def order(count, edges):
    """Evaluation order: every operator after the operators it reads. Loops are refused."""
    result, state = [], {}
    def visit(node):
        if state.get(node) == 2: return
        if state.get(node) == 1: raise ValueError('Operators cannot feed each other in a loop')
        state[node] = 1
        for source in sorted(edges.get(node, ())): visit(source)
        state[node] = 2; result.append(node)
    for node in range(count): visit(node)
    return result


def apply_kind(kind, params, values, state, now):
    """The function itself. ``values`` are the input signals; returns the output signal."""
    if kind == 'sum': return sum(values) * params['gain']
    if kind == 'average': return sum(values) / len(values) if values else 0.
    if kind == 'multiply':
        result = 1. if values else 0.
        for value in values: result *= value
        return result
    if kind == 'min': return min(values) if values else 0.
    if kind == 'max': return max(values) if values else 0.
    x = values[0] if values else 0.
    if kind == 'scale': return x * params['amount'] + params['offset']
    if kind == 'invert': return -x
    if kind == 'abs': return abs(x)
    if kind == 'curve':
        exponent = 2 ** (params['curve'] * 2)
        return math.copysign(abs(x) ** exponent, x)
    if kind == 'quantize':
        scale = SCALES[int(round(params['scale']))]
        if scale is None:
            steps = max(2, int(round(params['steps'])))
            return round(x * steps) / steps
        # Musical: treat |x| as 0..127 on the keyboard, snap to the nearest scale tone.
        root = int(round(params['root'])) % 12
        note = abs(x) * 127
        tones = [n for n in range(128) if (n - root) % 12 in scale]
        return math.copysign(min(tones, key=lambda n: abs(n - note)) / 127, x)
    if kind == 'smooth':
        last, stamp = state.get('smooth', (x, now))
        dt = max(0., now - stamp)
        alpha = 1 - math.exp(-dt * 1000 / params['time_ms'])
        value = last + (x - last) * alpha
        state['smooth'] = (value, now)
        return value
    if kind == 'threshold': return 1. if x >= params['level'] else 0.
    gates = [value > .5 for value in values]
    if kind == 'and': return 1. if gates and all(gates) else 0.
    if kind == 'or': return 1. if any(gates) else 0.
    if kind == 'xor': return 1. if sum(gates) % 2 == 1 else 0.
    if kind == 'not': return 0. if (values[0] if values else 0.) > .5 else 1.
    raise ValueError('Unknown operator kind')


class OperatorGraph:
    """Evaluates the operators once per engine tick."""

    def __init__(self, operators):
        self.operators = operators
        edges = {i: {s['index'] for s in op['inputs'] if s['type'] == 'op'} for i, op in enumerate(operators)}
        self.order = order(len(operators), edges)
        self.values = [0.] * len(operators)
        self.state = [dict() for _ in operators]

    def evaluate(self, mod_signals, cc_values, now):
        for i in self.order:
            op = self.operators[i]
            params = dict(op['params'])
            for name, link in op['links'].items():
                raw = cc_values.get((link['controller'], link['channel'], link['number']))
                if raw is None: continue
                _, low, high = KINDS[op['kind']][1][name]
                params[name] = low + raw / 127 * (high - low)
            values = []
            for source in op['inputs']:
                if source['type'] == 'mod': values.append(mod_signals[source['index']] if source['index'] < len(mod_signals) else 0.)
                elif source['type'] == 'op': values.append(self.values[source['index']])
                else: values.append(cc_values.get((source['controller'], source['channel'], source['number']), 0) / 127)
            self.values[i] = apply_kind(op['kind'], params, values, self.state[i], now)
        return self.values
