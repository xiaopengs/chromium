#!/usr/bin/env python
#
# Copyright (c) 2012 The Chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.

"""Runs all the native unit tests.

1. Copy over test binary to /data/local on device.
2. Resources: chrome/unit_tests requires resources (chrome.pak and en-US.pak)
   to be deployed to the device. We use the device's $EXTERNAL_STORAGE as the
   base dir (which maps to Context.getExternalFilesDir()).
3. Environment:
3.1. chrome/unit_tests requires (via chrome_paths.cc) a directory named:
     $EXTERNAL_STORAGE + /chrome/test/data
3.2. page_cycler_tests have following requirements,
3.2.1  the following data on host:
       <chrome_src_dir>/tools/page_cycler
       <chrome_src_dir>/data/page_cycler
3.2.2. two data directories to store above test data on device named:
       $EXTERNAL_STORAGE + /tools/ (for database perf test)
       $EXTERNAL_STORAGE + /data/ (for other perf tests)
3.2.3. a http server to serve http perf tests.
       The http root is host's <chrome_src_dir>/data/page_cycler/, port 8000.
3.2.4  a tool named forwarder is also required to run on device to
       forward the http request/response between host and device.
3.2.5  Chrome is installed on device.
4. Run the binary in the device and stream the log to the host.
4.1. Optionally, filter specific tests.
4.2. Optionally, rebaseline: run the available tests and update the
     suppressions file for failures.
4.3. If we're running a single test suite and we have multiple devices
     connected, we'll shard the tests.
5. Clean up the device.

Suppressions:

Individual tests in a test binary can be suppressed by listing it in
the gtest_filter directory in a file of the same name as the test binary,
one test per line. Here is an example:

  $ cat gtest_filter/base_unittests_disabled
  DataPackTest.Load
  ReadOnlyFileUtilTest.ContentsEqual

This file is generated by the tests running on devices. If running on emulator,
additonal filter file which lists the tests only failed in emulator will be
loaded. We don't care about the rare testcases which succeeded on emuatlor, but
failed on device.
"""

import copy
import fnmatch
import logging
import optparse
import os
import signal
import subprocess
import sys
import time

from pylib import android_commands
from pylib.base_test_sharder import BaseTestSharder
from pylib import buildbot_report
from pylib import cmd_helper
from pylib import constants
from pylib import debug_info
import emulator
from pylib import ports
from pylib import run_tests_helper
from pylib import test_options_parser
from pylib.single_test_runner import SingleTestRunner
from pylib.test_result import BaseTestResult, TestResults


_TEST_SUITES = ['base_unittests',
                'cc_unittests',
                'cc_perftests',
                'content_unittests',
                'gpu_unittests',
                'ipc_tests',
                'media_unittests',
                'net_unittests',
                'sql_unittests',
                'sync_unit_tests',
                'ui_unittests',
                'unit_tests',
                'webkit_compositor_bindings_unittests',
               ]


def FullyQualifiedTestSuites(exe, option_test_suite, build_type):
  """Return a fully qualified list

  Args:
    exe: if True, use the executable-based test runner.
    option_test_suite: the test_suite specified as an option.
    build_type: 'Release' or 'Debug'.
  """
  test_suite_dir = os.path.join(cmd_helper.OutDirectory.get(), build_type)
  if option_test_suite:
    all_test_suites = [option_test_suite]
  else:
    all_test_suites = _TEST_SUITES

  if exe:
    qualified_test_suites = [os.path.join(test_suite_dir, t)
                             for t in all_test_suites]
  else:
    # out/(Debug|Release)/$SUITE_apk/$SUITE-debug.apk
    qualified_test_suites = [os.path.join(test_suite_dir,
                                          t + '_apk',
                                          t + '-debug.apk')
                             for t in all_test_suites]
  for t, q in zip(all_test_suites, qualified_test_suites):
    if not os.path.exists(q):
      logging.critical('Test suite %s not found in %s.\n'
                       'Supported test suites:\n %s\n'
                       'Ensure it has been built.\n',
                       t, q, _TEST_SUITES)
      return []
  return qualified_test_suites


class TimeProfile(object):
  """Class for simple profiling of action, with logging of cost."""

  def __init__(self, description):
    self._description = description
    self.Start()

  def Start(self):
    self._starttime = time.time()

  def Stop(self):
    """Stop profiling and dump a log."""
    if self._starttime:
      stoptime = time.time()
      logging.info('%fsec to perform %s',
                   stoptime - self._starttime, self._description)
      self._starttime = None


class Xvfb(object):
  """Class to start and stop Xvfb if relevant.  Nop if not Linux."""

  def __init__(self):
    self._pid = 0

  def _IsLinux(self):
    """Return True if on Linux; else False."""
    return sys.platform.startswith('linux')

  def Start(self):
    """Start Xvfb and set an appropriate DISPLAY environment.  Linux only.

    Copied from tools/code_coverage/coverage_posix.py
    """
    if not self._IsLinux():
      return
    proc = subprocess.Popen(['Xvfb', ':9', '-screen', '0', '1024x768x24',
                             '-ac'],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    self._pid = proc.pid
    if not self._pid:
      raise Exception('Could not start Xvfb')
    os.environ['DISPLAY'] = ':9'

    # Now confirm, giving a chance for it to start if needed.
    for _ in range(10):
      proc = subprocess.Popen('xdpyinfo >/dev/null', shell=True)
      _, retcode = os.waitpid(proc.pid, 0)
      if retcode == 0:
        break
      time.sleep(0.25)
    if retcode != 0:
      raise Exception('Could not confirm Xvfb happiness')

  def Stop(self):
    """Stop Xvfb if needed.  Linux only."""
    if self._pid:
      try:
        os.kill(self._pid, signal.SIGKILL)
      except:
        pass
      del os.environ['DISPLAY']
      self._pid = 0


class TestSharder(BaseTestSharder):
  """Responsible for sharding the tests on the connected devices."""

  def __init__(self, attached_devices, test_suite, gtest_filter,
               test_arguments, timeout, rebaseline, performance_test,
               cleanup_test_files, tool, log_dump_name, fast_and_loose,
               build_type, in_webkit_checkout):
    BaseTestSharder.__init__(self, attached_devices, build_type)
    self.test_suite = test_suite
    self.test_suite_basename = os.path.basename(test_suite)
    self.gtest_filter = gtest_filter or ''
    self.test_arguments = test_arguments
    self.timeout = timeout
    self.rebaseline = rebaseline
    self.performance_test = performance_test
    self.cleanup_test_files = cleanup_test_files
    self.tool = tool
    self.log_dump_name = log_dump_name
    self.fast_and_loose = fast_and_loose
    self.build_type = build_type
    self.in_webkit_checkout = in_webkit_checkout
    self.tests = []
    if not self.gtest_filter:
      # No filter has been specified, let's add all tests then.
      self.tests, self.attached_devices = self._GetTests()

  def _GetTests(self):
    """Returns a tuple of (all_tests, available_devices).

    Tries to obtain the list of available tests.
    Raises Exception if all devices failed.
    """
    available_devices = list(self.attached_devices)
    while available_devices:
      try:
        logging.info('Obtaining tests from %s', available_devices[-1])
        all_tests = self._GetTestsFromDevice(available_devices[-1])
        return all_tests, available_devices
      except Exception as e:
        logging.info('Failed obtaining tests from %s %s',
                     available_devices[-1], e)
        available_devices.pop()
    raise Exception('No device available to get the list of tests.')

  def _GetTestsFromDevice(self, device):
    test = SingleTestRunner(device, self.test_suite, self.gtest_filter,
                            self.test_arguments, self.timeout, self.rebaseline,
                            self.performance_test, self.cleanup_test_files,
                            self.tool, 0,
                            not not self.log_dump_name, self.fast_and_loose,
                            self.build_type, self.in_webkit_checkout)
    # The executable/apk needs to be copied before we can call GetAllTests.
    test.test_package.StripAndCopyExecutable()
    all_tests = test.test_package.GetAllTests()
    if not self.rebaseline:
      disabled_list = test.GetDisabledTests()
      # Only includes tests that do not have any match in the disabled list.
      all_tests = filter(lambda t:
                         not any([fnmatch.fnmatch(t, disabled_pattern)
                                  for disabled_pattern in disabled_list]),
                         all_tests)
    return all_tests

  def CreateShardedTestRunner(self, device, index):
    """Creates a suite-specific test runner.

    Args:
      device: Device serial where this shard will run.
      index: Index of this device in the pool.

    Returns:
      A SingleTestRunner object.
    """
    device_num = len(self.attached_devices)
    shard_size = (len(self.tests) + device_num - 1) / device_num
    shard_test_list = self.tests[index * shard_size : (index + 1) * shard_size]
    test_filter = ':'.join(shard_test_list) + self.gtest_filter
    return SingleTestRunner(device, self.test_suite,
                            test_filter, self.test_arguments, self.timeout,
                            self.rebaseline, self.performance_test,
                            self.cleanup_test_files, self.tool, index,
                            not not self.log_dump_name, self.fast_and_loose,
                            self.build_type, self.in_webkit_checkout)

  def OnTestsCompleted(self, test_runners, test_results):
    """Notifies that we completed the tests."""
    test_results.LogFull('Unit test', os.path.basename(self.test_suite),
                         self.build_type, self.tests)
    test_results.PrintAnnotation()
    if test_results.failed and self.rebaseline:
      test_runners[0].UpdateFilter(test_results.failed)
    if self.log_dump_name:
      # Zip all debug info outputs into a file named by log_dump_name.
      debug_info.GTestDebugInfo.ZipAndCleanResults(
          os.path.join(cmd_helper.OutDirectory.get(), self.build_type,
              'debug_info_dumps'),
          self.log_dump_name)


def _RunATestSuite(options):
  """Run a single test suite.

  Helper for Dispatch() to allow stop/restart of the emulator across
  test bundles.  If using the emulator, we start it on entry and stop
  it on exit.

  Args:
    options: options for running the tests.

  Returns:
    0 if successful, number of failing tests otherwise.
  """
  step_name = os.path.basename(options.test_suite).replace('-debug.apk', '')
  buildbot_report.PrintNamedStep(step_name)
  attached_devices = []
  buildbot_emulators = []

  if options.use_emulator:
    for n in range(options.emulator_count):
      t = TimeProfile('Emulator launch %d' % n)
      avd_name =  None
      if n > 0:
        # Creates a temporary AVD for the extra emulators.
        avd_name = 'run_tests_avd_%d' % n
      buildbot_emulator = emulator.Emulator(avd_name, options.fast_and_loose)
      buildbot_emulator.Launch(kill_all_emulators=n == 0)
      t.Stop()
      buildbot_emulators.append(buildbot_emulator)
      attached_devices.append(buildbot_emulator.device)
    # Wait for all emulators to boot completed.
    map(lambda buildbot_emulator: buildbot_emulator.ConfirmLaunch(True),
        buildbot_emulators)
  elif options.test_device:
    attached_devices = [options.test_device]
  else:
    attached_devices = android_commands.GetAttachedDevices()

  if not attached_devices:
    logging.critical('A device must be attached and online.')
    buildbot_report.PrintError()
    return 1

  # Reset the test port allocation. It's important to do it before starting
  # to dispatch any tests.
  if not ports.ResetTestServerPortAllocation():
    raise Exception('Failed to reset test server port.')

  if options.performance_test or options.gtest_filter:
    # These configuration can't be split in multiple devices.
    attached_devices = [attached_devices[0]]
  sharder = TestSharder(attached_devices, options.test_suite,
                        options.gtest_filter, options.test_arguments,
                        options.timeout, options.rebaseline,
                        options.performance_test,
                        options.cleanup_test_files, options.tool,
                        options.log_dump, options.fast_and_loose,
                        options.build_type, options.webkit)
  test_results = sharder.RunShardedTests()

  for buildbot_emulator in buildbot_emulators:
    buildbot_emulator.Shutdown()

  return len(test_results.failed)


def Dispatch(options):
  """Dispatches the tests, sharding if possible.

  If options.use_emulator is True, all tests will be run in new emulator
  instance.

  Args:
    options: options for running the tests.

  Returns:
    0 if successful, number of failing tests otherwise.
  """
  if options.test_suite == 'help':
    ListTestSuites()
    return 0

  if options.use_xvfb:
    xvfb = Xvfb()
    xvfb.Start()

  all_test_suites = FullyQualifiedTestSuites(options.exe, options.test_suite,
                                             options.build_type)
  failures = 0
  for suite in all_test_suites:
    # Give each test suite its own copy of options.
    test_options = copy.deepcopy(options)
    test_options.test_suite = suite
    failures += _RunATestSuite(test_options)

  if options.use_xvfb:
    xvfb.Stop()
  return failures


def ListTestSuites():
  """Display a list of available test suites."""
  print 'Available test suites are:'
  for test_suite in _TEST_SUITES:
    print test_suite


def main(argv):
  option_parser = optparse.OptionParser()
  test_options_parser.AddTestRunnerOptions(option_parser, default_timeout=0)
  option_parser.add_option('-s', '--suite', dest='test_suite',
                           help='Executable name of the test suite to run '
                           '(use -s help to list them)')
  option_parser.add_option('--out-directory', dest='out_directory',
                           help='Path to the out/ directory, irrespective of '
                           'the build type. Only for non-Chromium uses.')
  option_parser.add_option('-d', '--device', dest='test_device',
                           help='Target device the test suite to run ')
  option_parser.add_option('-r', dest='rebaseline',
                           help='Rebaseline and update *testsuite_disabled',
                           action='store_true')
  option_parser.add_option('-f', '--gtest_filter', dest='gtest_filter',
                           help='gtest filter')
  option_parser.add_option('-a', '--test_arguments', dest='test_arguments',
                           help='Additional arguments to pass to the test')
  option_parser.add_option('-p', dest='performance_test',
                           help='Indicator of performance test',
                           action='store_true')
  option_parser.add_option('-L', dest='log_dump',
                           help='file name of log dump, which will be put in '
                           'subfolder debug_info_dumps under the same '
                           'directory in where the test_suite exists.')
  option_parser.add_option('-e', '--emulator', dest='use_emulator',
                           action='store_true',
                           help='Run tests in a new instance of emulator')
  option_parser.add_option('-n', '--emulator_count',
                           type='int', default=1,
                           help='Number of emulators to launch for running the '
                           'tests.')
  option_parser.add_option('-x', '--xvfb', dest='use_xvfb',
                           action='store_true',
                           help='Use Xvfb around tests (ignored if not Linux)')
  option_parser.add_option('--webkit', action='store_true',
                           help='Run the tests from a WebKit checkout.')
  option_parser.add_option('--fast', '--fast_and_loose', dest='fast_and_loose',
                           action='store_true',
                           help='Go faster (but be less stable), '
                           'for quick testing.  Example: when tracking down '
                           'tests that hang to add to the disabled list, '
                           'there is no need to redeploy the test binary '
                           'or data to the device again.  '
                           'Don\'t use on bots by default!')
  option_parser.add_option('--repeat', dest='repeat', type='int',
                           default=2,
                           help='Repeat count on test timeout')
  option_parser.add_option('--exit_code', action='store_true',
                           help='If set, the exit code will be total number '
                           'of failures.')
  option_parser.add_option('--exe', action='store_true',
                           help='If set, use the exe test runner instead of '
                           'the APK.')

  options, args = option_parser.parse_args(argv)
  if len(args) > 1:
    print 'Unknown argument:', args[1:]
    option_parser.print_usage()
    sys.exit(1)
  run_tests_helper.SetLogLevel(options.verbose_count)
  if options.out_directory:
    cmd_helper.OutDirectory.set(options.out_directory)
  emulator.DeleteAllTempAVDs()
  failed_tests_count = Dispatch(options)

  # Failures of individual test suites are communicated by printing a
  # STEP_FAILURE message.
  # Returning a success exit status also prevents the buildbot from incorrectly
  # marking the last suite as failed if there were failures in other suites in
  # the batch (this happens because the exit status is a sum of all failures
  # from all suites, but the buildbot associates the exit status only with the
  # most recent step).
  if options.exit_code:
    return failed_tests_count
  return 0


if __name__ == '__main__':
  sys.exit(main(sys.argv))
