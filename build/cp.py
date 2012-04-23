#!/usr/bin/env python
# Copyright (c) 2012 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

"""Copy a file.

This module works much like the cp posix command - it takes 2 arguments:
(src, dst) and copies the file with path |src| to |dst|.
"""

import shutil
import sys


def Main(src, dst):
  return shutil.copyfile(src, dst)


if __name__ == '__main__':
  sys.exit(Main(sys.argv[1], sys.argv[2]))
