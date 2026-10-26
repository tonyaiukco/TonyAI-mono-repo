#!/usr/bin/env python3
"""Use Ubuntu's primary archive for Playwright apt dependencies on CI hosts."""
from pathlib import Path
import re

SOURCES = Path('/etc/apt/sources.list.d/ubuntu.sources')
CONFIG = Path('/etc/apt/apt.conf.d/80tonyai-downloads')
OPTIONS = '''Acquire::Retries "2";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
'''


# GitHub's Ubuntu images point their archive stanza at a mirror list
# (mirror+file:/etc/apt/apt-mirrors.txt) whose first entry is the Azure mirror,
# so the Azure URI never appears on the URIs line itself.
AZURE_URI = r'https?://azure\.archive\.ubuntu\.com/ubuntu/?'
MIRROR_LIST_URI = r'mirror\+file:/etc/apt/apt-mirrors\.txt'


def primary_archive(source):
    # Only replace exact URI tokens on deb822 URIs lines. Keep suites,
    # components, security updates and Signed-By verification unchanged.
    return re.sub(r'(?m)^(URIs:[^\n]*)$', lambda line: re.sub(
        rf'(?<!\S)(?:{AZURE_URI}|{MIRROR_LIST_URI})(?=\s|$)',
        'https://archive.ubuntu.com/ubuntu/', line[0]), source)


if __name__ == '__main__':
    before = SOURCES.read_text()
    after = primary_archive(before)
    SOURCES.write_text(after)
    CONFIG.write_text(OPTIONS)
    # Name the outcome so a future image change shows up in the log, not as a slow download.
    print('apt sources rewritten to the primary archive' if after != before
          else 'apt sources unchanged: no Azure mirror URI found')
