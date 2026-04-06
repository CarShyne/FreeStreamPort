import sys
import json
from guessit import guessit

filename = sys.argv[1]
result = guessit(filename)
print(json.dumps({
    'title': result.get('title', ''),
    'year': str(result.get('year', '')) if result.get('year') else ''
}))
