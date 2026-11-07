"""Route native Twister page 2 through L6 DIN; leave page switching to hardware."""
import argparse
import json
from pathlib import Path


def configure(profile, output):
    from midibrain.performance.rigs import twister_page2
    return twister_page2(profile, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('--output-port', required=True)
    parser.add_argument('--write-to', required=True, type=Path, help='New profile path; existing files are never replaced')
    args = parser.parse_args()
    from midibrain.performance.profile import validate
    profile = configure(json.loads(args.config.read_text()), args.output_port)
    validate(profile, allow_unverified=True)
    with args.write_to.open('x') as stream:
        stream.write(json.dumps(profile, indent=2)+'\n')
    print(f'Created {args.write_to}; original profile preserved')


if __name__ == '__main__':
    main()
