'use strict';

angular.module('authService', [])

.service('authService', function (
  $log, $q, $interval, $window, $state, $location, $rootScope,
  appConfig, api, tokenService, alertService) {

  var popupElm;
  var asyncToken;
  var asyncUser = $q.defer();
  var isFirstAuthenticate = true;

  var user = {
    isPending      : true,
    isAuthenticated: false,
    identity       : null
  };

  this.loginPopup        = loginPopup;
  this.loginRedirect     = loginRedirect;
  this.logout            = logout;
  this.logoutRedirect    = logoutRedirect;
  this.subscribe         = subscribe;
  this.user              = user;
  this.authenticatedUser = authenticatedUser;

  // return user, authenticated or not
  this.userPromise = function () {
    return asyncUser.promise;
  };

  // included for compatibility:
  this.me = authenticatedUser;

  // included for compatibility:
  this.isLoggedIn = function () {
    $log.debug('DEPRECATED: authService.isLoggedIn(), use authService.user.isAuthenticated');
    return user.isAuthenticated;
  };

  // included for compatibility:
  this.invalidateMe = function () {
    $log.debug('DEPRECATED: authService.invalidateMe(), use authService.authenticatedUser(true) to reload');
    this.me(!!'forceReload');
  };

  // EVENTS

  // close popup when window is closed
  $window.addEventListener('beforeunload', closePopup);

  $rootScope.$on('openwheels:fatal-401', function (e, err) {
    $log.debug('openwheels:fatal-401');
    alertService.loaded();
    alertService.closeAll();

    tokenService.clearToken();
    user.isAuthenticated = false;
    user.identity = null;
    user.isPending = false;

    asyncUser = null; // make sure it never gets resolved;
    window.location.reload();
  });

  this.notifyAnonymous = function () {
    user.isAuthenticated = false;
    user.identity = null;
    user.isPending = false;
    if (asyncToken) {
      asyncToken.reject('anonymous');
      asyncToken = null;
    }
    if (asyncUser) {
      asyncUser.resolve(user);
    }
    isFirstAuthenticate = false;
  };

  this.notifyFreshToken = function (freshToken) {
    var remaining;
    user.isAuthenticated = true;
    if (asyncToken) {
      asyncToken.resolve(freshToken);
      asyncToken = null;
    }
    if (isFirstAuthenticate) {
      if (moment(freshToken.expiryDate).isValid()) {
        remaining = moment.duration({ seconds: freshToken.expiresIn() });
        $log.debug('[*] AUTHENTICATED, token expires in ' + remaining.humanize() + ' (' + remaining.asSeconds() + ' sec)');
      } else {
        $log.debug('[*] AUTHENTICATED, assume token not expired (invalid expiry date)');
      }
      loadIdentity();
      isFirstAuthenticate = false;
    }
  };

  this.notifyTokenError = function () {
    if (asyncToken) {
      asyncToken.reject();
      asyncToken = null;
    }
  };

  // ! Use only in direct response to user interaction, may trigger login popup
  function authenticatedUser (forceReload) {
    if (forceReload) {
      // reject pending
      if (asyncUser) {
        asyncUser.reject('forced reload');
      }
      // create new
      asyncUser = $q.defer();
      loadIdentity();
    }
    if (!user.isAuthenticated && !user.isPending) {
      return loginPopup().catch(function (err) {
        return $q.reject(new Error('Je bent niet ingelogd'));
      });
    }
    return asyncUser.promise.then(function (user) {
      return user.isAuthenticated ? user.identity : $q.reject(new Error('Je bent niet ingelogd'));
    });
  }

  function loginPopup () {
    if (user.isAuthenticated) { throw new Error('already logged in'); }
    if (asyncToken) {
      asyncToken.reject(new Error('token canceled by popup'));
      asyncToken = null;
    }
    asyncToken = $q.defer();
    var loginPromise = asyncToken.promise.then(function () {
      return authenticatedUser(!!'forceReload');
    });
    alertService.closeAll();
    alertService.loaded();

    if (isInternetExplorer()) {
      loginRedirect('/');
    } else {
      openPopup(authUrl('postMessage', 'postMessage'));
    }
    return loginPromise;
  }

  function isInternetExplorer () {
    var ua = window.navigator.userAgent;
    return !!( ~ua.indexOf('MSIE ') || ~ua.indexOf('Trident/') );
  }

  function loginRedirect (errorPath, successPath) {
    if (user.isAuthenticated) { throw new Error('already logged in'); }
    var currentPath = $location.url();
    $window.location.href = authUrl(errorPath, successPath || currentPath);
  }

  function loadIdentity () {
    $log.debug('--> ' + (user.identity ? 're-' : '') + 'load identity');
    user.isPending = true;
    api.invokeRpcMethod('person.me').then(function (identity) {
      $log.debug('<-- got identity');
      user.identity = identity;
      user.isPending = false;
      if (asyncUser) {
        asyncUser.resolve(user);
      }
    })
    .catch(function (err) {
      $log.debug('<!! got identity error');
      user.isPending = false;
      user.isAuthenticated = false;
      user.identity = null;
      if (asyncUser) {
        asyncUser.reject(err);
      }
    });
  }

  // server side / platform logout
  function logoutRedirect () {
    $log.debug('redirect to logout');
    tokenService.clearToken();
    var logoutUrl = appConfig.serverUrl + '/logout?redirect_to=' + encodeURIComponent(appConfig.appUrl);
    $window.location.href = logoutUrl;
  }

  // revoke access token by calling auth.logout
  function logout () {
    var dfd = $q.defer();

    if (asyncToken) {
      asyncToken.reject(new Error('token canceled by logout'));
      asyncToken = null;
    }

    $log.debug('--> logout');
    user.isPending = true;
    api.invokeRpcMethod('auth.logout').then(function () {
      $log.debug('<-- logged out');
      user.isAuthenticated = false;
      user.identity = null;
      user.isPending = false;
      tokenService.clearToken();
      if (asyncUser) {
        asyncUser.resolve(user);
      }
      dfd.resolve();
    })
    .catch(function () {
      $log.debug('<!! error logging out, clear user anyway');
      user.isAuthenticated = false;
      user.identity = null;
      user.isPending = false;
      tokenService.clearToken();
      if (asyncUser) {
        asyncUser.resolve(user);
      }
    });
    return dfd.promise;
  }

  function subscribe (params) {
    return api.invokeRpcMethod('person.subscribe', params, null, true);
  }

  // HELPERS

  function authUrl (errorPath, successPath) {
    var oAuth2CallbackUrl =
      $window.location.protocol + '//' +
      $window.location.host +
      $window.location.pathname +
      $state.href('oauth2callback') +
      '?' +
      ( !successPath ? '' : '&successPath=' + encodeURIComponent(successPath) ) +
      ( !errorPath   ? '' : '&errorPath=' + encodeURIComponent(errorPath) );

    return appConfig.authEndpoint +
      '?client_id='     + appConfig.appId +
      '&response_type=' + 'token' +
      '&redirect_uri='  + encodeURIComponent(oAuth2CallbackUrl);
  }

  var closeTimer;
  function openPopup (url) {
    closePopup();
    var w = 800;
    var h = 510;
    var left = (screen.width / 2) - (w / 2);
    var top = (screen.height / 2) - (h / 2);
    popupElm = $window.open(url, 'Login', '' +
      ', width=' + w +
      ', height=' + h +
      ', top=' + top +
      ', left=' + left);

    // watch popup close
    $interval.cancel(closeTimer);
    closeTimer = $interval(function () {
      if (popupElm && popupElm.closed) {
        $interval.cancel(closeTimer);
        if (asyncToken) {
          asyncToken.reject('popup closed');
          asyncToken = null;
        }
      }
    }, 250);
    return popupElm;
  }

  function closePopup () {
    if (popupElm) {
      popupElm.close();
      popupElm = null;
    }
  }

});
