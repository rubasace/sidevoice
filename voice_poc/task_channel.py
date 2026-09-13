"""Nonblocking task subscriptions for the actual coordinating conversation."""
import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['watch', 'unwatch', 'status'])
    parser.add_argument('--thread-id', required=True, help='Real ID of the coordinating task')
    parser.add_argument('--target')
    parser.add_argument('--include-current', action='store_true')
    parser.add_argument('--rearm', action='store_true')
    parser.add_argument('--expected-turn-id')
    args = parser.parse_args()
    if args.action != 'status' and not args.target:
        parser.error('--target required')
    payload = {'thread_id': args.thread_id, 'target_id': args.target,
               'include_current': args.include_current, 'rearm': args.rearm,
               'expected_turn_id': args.expected_turn_id}
    registry = Path(__file__).resolve().parent.parent / '.voice-poc' / 'gateways' / (args.thread_id + '.json')
    gateway = json.loads(registry.read_text())['url'] if registry.is_file() else 'http://127.0.0.1:8769'
    url = gateway + '/tasks/' + ('state' if args.action == 'status' else args.action)
    data = None if args.action == 'status' else json.dumps(payload).encode()
    if data is None:
        from urllib.parse import urlencode
        url += '?' + urlencode({'thread_id': args.thread_id})
    try:
        request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            print(response.read().decode())
        return 0
    except urllib.error.HTTPError as error:
        print(error.read().decode())
    except OSError as error:
        print(json.dumps({'error': 'Monitor no disponible', 'detail': str(error)}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
