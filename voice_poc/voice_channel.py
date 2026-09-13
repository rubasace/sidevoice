"""Call through the agent's existing shell tool; audio playback never blocks it."""
import argparse
import json
import sys
import urllib.request
import urllib.error
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['status', 'speak'])
    parser.add_argument('--thread-id')
    parser.add_argument('--session-id')
    parser.add_argument('--revision', type=int)
    parser.add_argument('--utterance-id', default=None)
    parser.add_argument('--language', choices=['es', 'en', 'fr', 'it', 'pt', 'hi'])
    args = parser.parse_args()
    url = 'http://127.0.0.1:8767/api/presentation'
    data = None
    if args.action == 'speak':
        if not args.thread_id or not args.session_id or args.revision is None:
            parser.error('speak requires --thread-id --session-id --revision captured at turn start')
        text = sys.stdin.read().strip()
        data = json.dumps({'thread_id': args.thread_id, 'text': text,
                           'language': args.language,
                           'session_id': args.session_id, 'revision': args.revision,
                           'utterance_id': args.utterance_id or str(uuid.uuid4())}).encode()
        url += '/speak'
    try:
        request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.loads(response.read().decode())
            if args.action == 'speak' and result.get('text_saved'):
                # Model-facing publication receipt. Audio policy belongs to the app.
                result = {'status': 'published', 'text_saved': True}
            print(json.dumps(result, ensure_ascii=False))
    except urllib.error.HTTPError as error:
        print(error.read().decode())
        return 1
    except OSError as error:
        print(json.dumps({'connected': False, 'error': 'Canal de voz no disponible', 'detail': str(error)}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
