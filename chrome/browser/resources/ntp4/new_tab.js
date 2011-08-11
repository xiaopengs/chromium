// Copyright (c) 2011 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @fileoverview New tab page
 * This is the main code for the new tab page used by touch-enabled Chrome
 * browsers.  For now this is still a prototype.
 */

// Use an anonymous function to enable strict mode just for this file (which
// will be concatenated with other files when embedded in Chrome
cr.define('ntp4', function() {
  'use strict';

  /**
   * The CardSlider object to use for changing app pages.
   * @type {CardSlider|undefined}
   */
  var cardSlider;

  /**
   * The 'page-list' element.
   * @type {!Element|undefined}
   */
  var pageList;

  /**
   * A list of all 'tile-page' elements.
   * @type {!NodeList|undefined}
   */
  var tilePages;

  /**
   * The Most Visited page.
   * @type {!Element|undefined}
   */
  var mostVisitedPage;

  /**
   * A list of all 'apps-page' elements.
   * @type {!NodeList|undefined}
   */
  var appsPages;

  /**
   * The Bookmarks page.
   * @type {!Element|undefined}
   */
  var bookmarksPage;

  /**
   * The 'dots-list' element.
   * @type {!Element|undefined}
   */
  var dotList;

  /**
   * A list of all 'dots' elements.
   * @type {!NodeList|undefined}
   */
  var dots;

  /**
   * The left and right paging buttons.
   * @type {!Element|undefined}
   */
  var pageSwitcherStart;
  var pageSwitcherEnd;

  /**
   * The 'trash' element.  Note that technically this is unnecessary,
   * JavaScript creates the object for us based on the id.  But I don't want
   * to rely on the ID being the same, and JSCompiler doesn't know about it.
   * @type {!Element|undefined}
   */
  var trash;

  /**
   * The type of page that is currently shown. The value is a numerical ID.
   * @type {number}
   */
  var shownPage = 0;

  /**
   * The index of the page that is currently shown, within the page type.
   * For example if the third Apps page is showing, this will be 2.
   * @type {number}
   */
  var shownPageIndex = 0;

  /**
   * EventTracker for managing event listeners for page events.
   * @type {!EventTracker}
   */
  var eventTracker = new EventTracker;

  /**
   * Object for accessing localized strings.
   * @type {!LocalStrings}
   */
  var localStrings = new LocalStrings;

  /**
   * If non-null, this is the ID of the app to highlight to the user the next
   * time getAppsCallback runs. "Highlight" in this case means to switch to
   * the page and run the new tile animation.
   * @type {String}
   */
  var highlightAppId = null;

  /**
   * The time in milliseconds for most transitions.  This should match what's
   * in new_tab.css.  Unfortunately there's no better way to try to time
   * something to occur until after a transition has completed.
   * @type {number}
   * @const
   */
  var DEFAULT_TRANSITION_TIME = 500;

  /**
   * Invoked at startup once the DOM is available to initialize the app.
   */
  function initialize() {
    cr.enablePlatformSpecificCSSRules();

    // Load the current theme colors.
    themeChanged();

    dotList = getRequiredElement('dot-list');
    pageList = getRequiredElement('page-list');
    trash = getRequiredElement('trash');
    new ntp4.Trash(trash);

    shownPage = templateData['shown_page_type'];
    shownPageIndex = templateData['shown_page_index'];

    // When a new app has been installed, we will be opened with a hash value
    // that corresponds to the new app ID.
    var hash = location.hash;
    if (hash && hash.indexOf('#app-id=') == 0) {
      highlightAppId = hash.split('=')[1];
      // Clear the hash so if the user bookmarks this page, they'll just get
      // chrome://newtab/.
      window.history.replaceState({}, '', '/');
    }

    // Request data on the apps so we can fill them in.
    // Note that this is kicked off asynchronously.  'getAppsCallback' will be
    // invoked at some point after this function returns.
    chrome.send('getApps');

    // Prevent touch events from triggering any sort of native scrolling
    document.addEventListener('touchmove', function(e) {
      e.preventDefault();
    }, true);

    dots = dotList.getElementsByClassName('dot');
    tilePages = pageList.getElementsByClassName('tile-page');
    appsPages = pageList.getElementsByClassName('apps-page');
    pageSwitcherStart = getRequiredElement('page-switcher-start');
    pageSwitcherStart.addEventListener('click', onPageSwitcherClicked);
    pageSwitcherStart.addEventListener('mousewheel', onPageSwitcherScrolled);
    pageSwitcherEnd = getRequiredElement('page-switcher-end');
    pageSwitcherEnd.addEventListener('click', onPageSwitcherClicked);
    pageSwitcherEnd.addEventListener('mousewheel', onPageSwitcherScrolled);

    // Initialize the cardSlider without any cards at the moment
    var sliderFrame = getRequiredElement('card-slider-frame');
    cardSlider = new CardSlider(sliderFrame, pageList, sliderFrame.offsetWidth);
    cardSlider.initialize();

    // Ensure the slider is resized appropriately with the window
    window.addEventListener('resize', function() {
      cardSlider.resize(sliderFrame.offsetWidth);
    });

    // Handle the page being changed
    pageList.addEventListener(
        CardSlider.EventType.CARD_CHANGED,
        cardChangedHandler);

    cr.ui.decorate($('recently-closed-menu-button'), ntp4.RecentMenuButton);
    chrome.send('getRecentlyClosedTabs');

    mostVisitedPage = new ntp4.MostVisitedPage();
    appendTilePage(mostVisitedPage, localStrings.getString('mostvisited'));
    chrome.send('getMostVisited');

    bookmarksPage = new ntp4.BookmarksPage();
    appendTilePage(bookmarksPage, localStrings.getString('bookmarksPage'));
    chrome.send('getBookmarks');
  }

  /**
   * Simple common assertion API
   * @param {*} condition The condition to test.  Note that this may be used to
   *     test whether a value is defined or not, and we don't want to force a
   *     cast to Boolean.
   * @param {string=} opt_message A message to use in any error.
   */
  function assert(condition, opt_message) {
    'use strict';
    if (!condition) {
      var msg = 'Assertion failed';
      if (opt_message)
        msg = msg + ': ' + opt_message;
      throw new Error(msg);
    }
  }

  /**
   * Get an element that's known to exist by its ID. We use this instead of just
   * calling getElementById and not checking the result because this lets us
   * satisfy the JSCompiler type system.
   * @param {string} id The identifier name.
   * @return {!Element} the Element.
   */
  function getRequiredElement(id) {
    var element = document.getElementById(id);
    assert(element, 'Missing required element: ' + id);
    return element;
  }

  /**
   * Callback invoked by chrome with the apps available.
   *
   * Note that calls to this function can occur at any time, not just in
   * response to a getApps request. For example, when a user installs/uninstalls
   * an app on another synchronized devices.
   * @param {Object} data An object with all the data on available
   *        applications.
   */
  function getAppsCallback(data) {
    var startTime = Date.now();

    // Clear any existing apps pages and dots.
    // TODO(rbyers): It might be nice to preserve animation of dots after an
    // uninstall. Could we re-use the existing page and dot elements?  It seems
    // unfortunate to have Chrome send us the entire apps list after an
    // uninstall.
    while (appsPages.length > 0) {
      var page = appsPages[0];
      var dot = page.navigationDot;

      eventTracker.remove(page);
      page.tearDown();
      page.parentNode.removeChild(page);
      dot.parentNode.removeChild(dot);
    }

    // Get the array of apps and add any special synthesized entries
    var apps = data.apps;

    // Get a list of page names
    var pageNames = data.appPageNames;

    function stringListIsEmpty(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i])
          return false;
      }
      return true;
    }

    if (!pageNames || stringListIsEmpty(pageNames))
      pageNames = [localStrings.getString('appDefaultPageName')];

    // Sort by launch index
    apps.sort(function(a, b) {
      return a.app_launch_index - b.app_launch_index;
    });

    // An app to animate (in case it was just installed).
    var highlightApp;

    // Add the apps, creating pages as necessary
    for (var i = 0; i < apps.length; i++) {
      var app = apps[i];
      var pageIndex = (app.page_index || 0);
      while (pageIndex >= appsPages.length) {
        var pageName = '';
        if (appsPages.length < pageNames.length)
          pageName = pageNames[appsPages.length];

        var origPageCount = appsPages.length;
        appendAppsPage(new ntp4.AppsPage(), pageName);
        // Confirm that appsPages is a live object, updated when a new page is
        // added (otherwise we'd have an infinite loop)
        assert(appsPages.length == origPageCount + 1, 'expected new page');
      }

      if (app.id == highlightAppId) {
        highlightApp = app;
        highlightAppId = null;
      } else {
        appsPages[pageIndex].appendApp(app);
      }
    }

    ntp4.AppsPage.setPromo(data.showPromo ? data : null);

    // Tell the slider about the pages
    updateSliderCards();

    if (highlightApp)
      appAdded(highlightApp);

    // Mark the current page
    dots[cardSlider.currentCard].classList.add('selected');
    logEvent('apps.layout: ' + (Date.now() - startTime));
  }

  /**
   * Called by chrome when a new app has been added to chrome.
   * @param {Object} app A data structure full of relevant information for the
   *     app.
   */
  function appAdded(app) {
    var pageIndex = app.page_index || 0;
    assert(pageIndex == 0, 'pageIndex != 0 not implemented');

    var page = appsPages[pageIndex];
    cardSlider.selectCardByValue(page);
    page.appendApp(app, true);
  }

  /**
   * Called by chrome when an existing app has been removed/uninstalled from
   * chrome.
   * @param {Object} appData A data structure full of relevant information for
   *     the app.
   */
  function appRemoved(appData) {
    var app = $(appData.id);
    assert(app, 'trying to remove an app that doesn\'t exist');

    var tile = findAncestorByClass(app, 'tile');
    tile.doRemove();
  }

  /**
   * Given a theme resource name, construct a URL for it.
   * @param {string} resourceName The name of the resource.
   * @return {string} A url which can be used to load the resource.
   */
  function getThemeUrl(resourceName) {
    return 'chrome://theme/' + resourceName;
  }

  /**
   * Callback invoked by chrome whenever an app preference changes.
   * @param {Object} data An object with all the data on available
   *     applications.
   */
  function appsPrefChangeCallback(data) {
    var apps = document.querySelectorAll('.app');

    // This is an expensive operation. We minimize how frequently it's called
    // by only calling it for changes across different instances of the NTP
    // (i.e. two separate tabs both showing NTP).
    for (var j = 0; j < data.apps.length; ++j) {
      for (var i = 0; i < apps.length; ++i) {
        if (data.apps[j]['id'] == apps[i].appId)
          apps[i].appData = data.apps[j];
      }
    }
  }

  function getCardSlider() {
    return cardSlider;
  }

  /**
   * Invoked whenever the pages in apps-page-list have changed so that
   * the Slider knows about the new elements.
   */
  function updateSliderCards() {
    var pageNo = cardSlider.currentCard;
    if (pageNo >= tilePages.length)
      pageNo = tilePages.length - 1;
    var pageArray = [];
    for (var i = 0; i < tilePages.length; i++)
      pageArray[i] = tilePages[i];
    cardSlider.setCards(pageArray, pageNo);

    if (shownPage == templateData['most_visited_page_id'])
      cardSlider.selectCardByValue(mostVisitedPage);
    else if (shownPage == templateData['apps_page_id'])
      cardSlider.selectCardByValue(appsPages[shownPageIndex]);
  }

  /**
   * Appends a tile page (for bookmarks or most visited).
   *
   * @param {TilePage} page The page element.
   * @param {string} title The title of the tile page.
   */
  function appendTilePage(page, title) {
    pageList.appendChild(page);

    // Make a deep copy of the dot template to add a new one.
    var newDot = new ntp4.NavDot(page, title, false, false);

    dotList.appendChild(newDot);
    page.navigationDot = newDot;

    eventTracker.add(page, 'pagelayout', onPageLayout);
  }

  /**
   * Appends an apps page into the page list.  This is like appendTilePage,
   * but takes care to insert before the Bookmarks page.
   * TODO(csilv): Refactor this function with appendTilePage to avoid
   *              duplication.
   *
   * @param {AppsPage} page The page element.
   * @param {string} title The title of the tile page.
   */
  function appendAppsPage(page, title) {
    pageList.insertBefore(page, bookmarksPage);

    // Make a deep copy of the dot template to add a new one.
    var animate = page.classList.contains('temporary');
    var newDot = new ntp4.NavDot(page, title, true, animate);

    dotList.insertBefore(newDot, bookmarksPage.navigationDot);
    page.navigationDot = newDot;

    eventTracker.add(page, 'pagelayout', onPageLayout);
  }

  /**
   * Search an elements ancestor chain for the nearest element that is a member
   * of the specified class.
   * @param {!Element} element The element to start searching from.
   * @param {string} className The name of the class to locate.
   * @return {Element} The first ancestor of the specified class or null.
   */
  function getParentByClassName(element, className) {
    for (var e = element; e; e = e.parentElement) {
      if (e.classList.contains(className))
        return e;
    }
    return null;
  }

  /**
   * Invoked whenever some app is grabbed
   * @param {Grabber.Event} e The Grabber Grab event.
   */
  function enterRearrangeMode(e) {
    var tempPage = new ntp4.AppsPage();
    tempPage.classList.add('temporary');
    appendAppsPage(tempPage, '');
    updateSliderCards();

    if (ntp4.getCurrentlyDraggingTile().firstChild.canBeRemoved())
      $('footer').classList.add('showing-trash-mode');
  }

  /**
   * Invoked whenever some app is released
   * @param {Grabber.Event} e The Grabber RELEASE event.
   */
  function leaveRearrangeMode(e) {
    var tempPage = document.querySelector('.tile-page.temporary');
    var dot = tempPage.navigationDot;
    if (!tempPage.tileCount) {
      dot.animateRemove();
      tempPage.parentNode.removeChild(tempPage);
      updateSliderCards();
    } else {
      tempPage.classList.remove('temporary');
      saveAppPageName(tempPage, '');
    }

    $('footer').classList.remove('showing-trash-mode');
  }

  /**
   * Callback for the 'click' event on a page switcher.
   * @param {Event} e The event.
   */
  function onPageSwitcherClicked(e) {
    cardSlider.selectCard(cardSlider.currentCard +
        (e.currentTarget == pageSwitcherStart ? -1 : 1), true);
  }

  /**
   * Handler for the mousewheel event on a pager. We pass through the scroll
   * to the page.
   * @param {Event} e The mousewheel event.
   */
  function onPageSwitcherScrolled(e) {
    cardSlider.currentCardValue.scrollBy(-e.wheelDeltaY);
  };

  /**
   * Callback for the 'pagelayout' event.
   * @param {Event} e The event.
   */
  function onPageLayout(e) {
    if (Array.prototype.indexOf.call(tilePages, e.currentTarget) !=
        cardSlider.currentCard) {
      return;
    }

    updatePageSwitchers();
  }

  /**
   * Adjusts the size and position of the page switchers according to the
   * layout of the current card.
   */
  function updatePageSwitchers() {
    var page = cardSlider.currentCardValue;

    pageSwitcherStart.hidden = !page || (cardSlider.currentCard == 0);
    pageSwitcherEnd.hidden = !page ||
        (cardSlider.currentCard == cardSlider.cardCount - 1);

    if (!page)
      return;

    var pageSwitcherLeft = isRTL() ? pageSwitcherEnd : pageSwitcherStart;
    var pageSwitcherRight = isRTL() ? pageSwitcherStart : pageSwitcherEnd;
    var scrollbarWidth = page.scrollbarWidth;
    pageSwitcherLeft.style.width =
        (page.sideMargin + 13) + 'px';
    pageSwitcherLeft.style.left = '0';
    pageSwitcherRight.style.width =
        (page.sideMargin - scrollbarWidth + 13) + 'px';
    pageSwitcherRight.style.right = scrollbarWidth + 'px';
  }

  /**
   * Returns the index of the given page.
   * @param {AppsPage} page The AppsPage for we wish to find.
   * @return {number} The index of |page|, or -1 if it is not here.
   */
  function getAppsPageIndex(page) {
    return Array.prototype.indexOf.call(appsPages, page);
  }

  // TODO(estade): rename newtab.css to new_tab_theme.css
  function themeChanged(hasAttribution) {
    $('themecss').href = 'chrome://theme/css/newtab.css?' + Date.now();
    if (typeof hasAttribution != 'undefined')
      document.documentElement.setAttribute('hasattribution', hasAttribution);
    updateLogo();
    updateAttribution();
  }

  /**
   * Sets the proper image for the logo at the bottom left.
   */
  function updateLogo() {
    var imageId = 'IDR_PRODUCT_LOGO';
    if (document.documentElement.getAttribute('customlogo') == 'true')
      imageId = 'IDR_CUSTOM_PRODUCT_LOGO';

    $('logo-img').src = 'chrome://theme/' + imageId + '?' + Date.now();
  }

  /**
   * Attributes the attribution image at the bottom left.
   */
  function updateAttribution() {
    var attribution = $('attribution');
    if (document.documentElement.getAttribute('hasattribution') == 'true') {
      $('attribution-img').src =
          'chrome://theme/IDR_THEME_NTP_ATTRIBUTION?' + Date.now();
      attribution.hidden = false;
    } else {
      attribution.hidden = true;
    }
  }

  /**
   * Handler for CARD_CHANGED on cardSlider.
   * @param {Event} e The CARD_CHANGED event.
   */
  function cardChangedHandler(e) {
    var page = e.cardSlider.currentCardValue;
    if (page.classList.contains('apps-page')) {
      shownPage = templateData['apps_page_id'];
      shownPageIndex = getAppsPageIndex(page);
    } else if (page.classList.contains('most-visited-page')) {
      shownPage = templateData['most_visited_page_id'];
      shownPageIndex = 0;
    } else if (page.classList.contains('bookmarks-page')) {
      shownPage = templateData['bookmarks_page_id'];
      shownPageIndex = 0;
    } else if (page.classList.contains('bookmarks-page')) {
      shownPage = templateData['bookmarks_page_id'];
      shownPageIndex = 0;
    } else {
      console.error('unknown page selected');
    }
    chrome.send('pageSelected', [shownPage, shownPageIndex]);

    // Update the active dot
    var curDot = dotList.getElementsByClassName('selected')[0];
    if (curDot)
      curDot.classList.remove('selected');
    var newPageIndex = e.cardSlider.currentCard;
    dots[newPageIndex].classList.add('selected');
    updatePageSwitchers();
  }

  /**
    * Timeout ID.
    * @type {number}
    */
  var notificationTimeout_ = 0;

  /**
   * Shows the notification bubble.
   * @param {string} text The notification message.
   * @param {Array.<{text: string, action: function()}>} links An array of
   *     records describing the links in the notification. Each record should
   *     have a 'text' attribute (the display string) and an 'action' attribute
   *     (a function to run when the link is activated).
   * @param {Function} opt_closeHandler The callback invoked if the user
   *     manually dismisses the notification.
   */
  function showNotification(text, links, opt_closeHandler) {
    window.clearTimeout(notificationTimeout_);
    document.querySelector('#notification > span').textContent = text;

    var linksBin = $('notificationLinks');
    linksBin.textContent = '';
    for (var i = 0; i < links.length; i++) {
      var link = linksBin.ownerDocument.createElement('div');
      link.textContent = links[i].text;
      var action = links[i].action;
      link.onclick = function(e) {
        action();
        hideNotification();
      }
      link.setAttribute('role', 'button');
      link.setAttribute('tabindex', 0);
      link.className = "linkButton";
      linksBin.appendChild(link);
    }

    document.querySelector('#notification button').onclick = function(e) {
      if (opt_closeHandler)
        opt_closeHandler();
      hideNotification();
    };

    $('notification').classList.remove('inactive');
    notificationTimeout_ = window.setTimeout(hideNotification, 10000);
  }

  /**
   * Hide the notification bubble.
   */
  function hideNotification() {
    $('notification').classList.add('inactive');
  }

  function setRecentlyClosedTabs(dataItems) {
    $('recently-closed-menu-button').dataItems = dataItems;
  }

  function setMostVisitedPages(data, hasBlacklistedUrls) {
    mostVisitedPage.data = data;
  }

  /**
   * Check the directionality of the page.
   * @return {boolean} True if Chrome is running an RTL UI.
   */
  function isRTL() {
    return document.documentElement.dir == 'rtl';
  }

  /*
   * Save the name of an app page.
   * Store the app page name into the preferences store.
   * @param {AppsPage} appPage The app page for which we wish to save.
   * @param {string} name The name of the page.
   */
  function saveAppPageName(appPage, name) {
    var index = getAppsPageIndex(appPage);
    assert(index != -1);
    chrome.send('saveAppPageName', [name, index]);
  }

  // Return an object with all the exports
  return {
    assert: assert,
    appAdded: appAdded,
    appRemoved: appRemoved,
    appsPrefChangeCallback: appsPrefChangeCallback,
    enterRearrangeMode: enterRearrangeMode,
    getAppsCallback: getAppsCallback,
    getCardSlider: getCardSlider,
    getAppsPageIndex: getAppsPageIndex,
    initialize: initialize,
    isRTL: isRTL,
    leaveRearrangeMode: leaveRearrangeMode,
    themeChanged: themeChanged,
    setRecentlyClosedTabs: setRecentlyClosedTabs,
    setMostVisitedPages: setMostVisitedPages,
    showNotification: showNotification,
    saveAppPageName: saveAppPageName
  };
});

// publish ntp globals
// TODO(estade): update the content handlers to use ntp namespace instead of
// making these global.
var assert = ntp4.assert;
var getAppsCallback = ntp4.getAppsCallback;
var appsPrefChangeCallback = ntp4.appsPrefChangeCallback;
var themeChanged = ntp4.themeChanged;
var recentlyClosedTabs = ntp4.setRecentlyClosedTabs;
var setMostVisitedPages = ntp4.setMostVisitedPages;

document.addEventListener('DOMContentLoaded', ntp4.initialize);
