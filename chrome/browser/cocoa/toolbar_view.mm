// Copyright (c) 2009 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/cocoa/toolbar_view.h"

@implementation ToolbarView

// Prevent mouse down events from moving the parent window around.
- (BOOL)mouseDownCanMoveWindow {
  return NO;
}

@end
