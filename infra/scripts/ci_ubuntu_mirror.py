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


def primary_archive(source):
    # Only replace exact URI tokens on deb822 URIs lines. Keep suites,
    # components, security updates and Signed-By verification unchanged.
    return re.sub(r'(?m)^(URIs:[^\n]*)$', lambda line: re.sub(
        r'(?<!\S)https?://azure\.archive\.ubuntu\.com/ubuntu/?(?=\s|$)',
        'https://archive.ubuntu.com/ubuntu/', line[0]), source)


if __name__ == '__main__':
    SOURCES.write_text(primary_archive(SOURCES.read_text()))
    CONFIG.write_text(OPTIONS)
