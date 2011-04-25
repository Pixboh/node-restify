// Copyright 2011 Mark Cavage <mcavage@gmail.com> All rights reserved.
var assert = require('assert');
var crypto = require('crypto');
var util = require('util');
var http = require('http');
var path = require('path');
var querystring = require('querystring');
var url = require('url');

var uuid = require('node-uuid');

var Constants = require('./constants');
var newError = require('./error').newError;
var log = require('./log');

// Just force this to extend http.ServerResponse
require('./http-extra');

var _response;

process.on('uncaughtException', function(error) {
  log.warn('uncaughtException: ' + error);
  if (error.stack) log.warn(error.stack);

  if (_response) {
    _response.writeHead(500);
    _response.end();
    _response = null;
  }

});

function _sanitizePath(path) {
  assert.ok(path);

  if (log.trace()) {
    log.trace('_sanitizePath: path=%s', path);
  }

  // Be nice like apache and strip out any //my//foo//bar///blah
  var _path = path.replace(/\/\/+/g, '/');

  // Kill a trailing '/'
  if (_path.lastIndexOf('/') === (_path.length - 1) &&
     _path.length > 1) {
    _path = _path.substr(0, _path.length - 1);
  }

  if (log.trace()) {
    log.trace('_sanitizePath: returning %s', _path);
  }
  return _path;
}


/**
 * Checks, if a mount matches, and if so, returns an object of all
 * the :param variables.
 *
 * @param {String} path (request.url.pathname).
 * @param {Object} route (what was mounted).
 */
function _matches(path, route) {
  assert.ok(path);
  assert.ok(route);

  if (path === route.url) {
    return {}; // there were no params in this case...
  }

  var params = route.urlComponents;
  var components = path.split('/').splice(1);
  var len = components.length;

  if (components.length !== params.length) return null;

  var parsed = {};
  for (var i = 0; i < params.length; i++) {
    var _url = url.parse(components[i]);
    if (params[i] === _url.pathname) continue;
    if (params[i].charAt(0) === ':') {
      parsed[params[i].substr(1)] = _url.pathname;
      continue;
    }
    return null;
  }

  return parsed;
}


function _parseRequest(request, response, next) {
  assert.ok(request);
  assert.ok(response);
  assert.ok(next);

    if (log.trace()) {
      log.trace('_parseRequest:\n%s %s HTTP/%s\nHeaders: %o',
                request.method,
                request.url,
                request.httpVersion,
                request.headers);
    }


  response._accept = Constants.ContentTypeJson;
  if (request.headers.accept) {
    var _mediaRange = request.headers.accept.split(';');
    if (!_mediaRange) {
      return response.sendError(newError({
        httpCode: 409,
        restCode: Constants.InvalidArgument,
        message: 'Accept header invalid: ' + request.headers.accept
      }));
    }
    var _acceptTypes = _mediaRange[0].split('/');
    if (!_acceptTypes || _acceptTypes.length !== 2) {
      return response.sendError(newError({
        httpCode: 409,
        restCode: Constants.InvalidArgument,
        message: 'Accept header invalid: ' + request.headers.accept
      }));
    }

    if (_acceptTypes[0] !== '*' && _acceptTypes[0] !== 'application') {
      if (log.trace()) {
        log.trace('accept header type doesn\'t match application');
      }
      return response.sendError(newError({
        httpCode: 415,
        restCode: Constants.InvalidArgument,
        message: request.headers.accept + ' unsupported'
      }));
    }
    if (_acceptTypes[1] === 'json' || _acceptTypes[1] === '*') {
      response._accept = Constants.ContentTypeJson;
      // TODO - add in libxml
      //    } else if (_acceptTypes[1] === 'xml') {
      //response._accept = Constants.ContentTypeXml;
    } else {
      if (log.trace()) {
        log.trace('accept header subtype isn\'t supported');
      }
      return response.sendError(newError({
        httpCode: 415,
        restCode: Constants.InvalidArgument,
        message: request.headers.accept + ' unsupported'
      }));
    }
  }

  if (log.trace()) {
    log.trace('Parsed accept type as: %s', response._accept);
  }

  // This is so common it's worth checking up front before we read data
  var contentType = request.contentType();
  if (contentType === 'multipart/form-data') {
    return response.sendError(newError({
      httpCode: 415,
      restCode: Constants.InvalidArgument,
      message: 'multipart/form-data unsupported'
    }));
  }

  if (request.headers[Constants.XApiVersion] || request._requireApiVersion) {
    if (request.headers[Constants.XApiVersion.toLowerCase()] !==
        request._apiVersion) {
      return response.sendError(newError({
        httpCode: 409,
        restCode: Constants.InvalidArgument,
        message: Constants.XApiVersion + ' must be ' + request._apiVersion
      }));
    }
  }

  request._url = url.parse(request.url);
  if (request._url.query) {
    var _qs = querystring.parse(request._url.query);
    for (var k in _qs) {
      if (_qs.hasOwnProperty(k)) {
        assert.ok(!request.params[k]);
        request.params[k] = _qs[k];
      }
    }
  }

  request.body = '';
  request.on('data', function(chunk) {
    if (request.body.length + chunk.length > 8192) {
      return response.sendError(newError({
        httpCode: 413,
        restCode: Constants.RequestTooLarge,
        message: 'maximum HTTP data size is 8k'
      }));
    }
    request.body += chunk;
  });

  request.on('end', function() {
    if (request.body) {
      var contentLen = request.headers['content-length'];
      if (contentLen !== undefined) {
        if (parseInt(contentLen, 10) !== request.body.length) {
          return response.sendError(newError({
            httpCode: 409,
            restCode: Constants.InvalidHeader,
            message: 'Content-Length=' + contentLen +
              ' didn\'t match actual length=' + request.body.length
          }));
        }
      }
      var bParams;
      if (contentType === Constants.ContentTypeFormEncoded) {
        bParams = querystring.parse(request.body) || {};
      } else if (contentType === Constants.ContentTypeJson) {
        try {
          bParams = JSON.parse(request.body);
        } catch (e) {
          return response.sendError(newError({
            httpCode: 409,
            restCode: Constants.InvalidArgument,
            message: 'Invalid JSON: ' + e.message
          }));
        }
      } else if (contentType) {
        return response.sendError(newError({
          httpCode: 415,
          restCode: Constants.InvalidArgument,
          message: contentType + ' unsupported'
        }));
      }

      for (var k in bParams) {
        if (bParams.hasOwnProperty(k)) {
          if (request.params.hasOwnProperty(k)) {
            return response.sendError(newError({
              httpCode: 409,
              restCode: Constants.InvalidArgument,
              message: 'duplicate parameter detected: ' + k
            }));
          }
          request.params[k] = bParams[k];
        }
      }
    }

    if (log.trace()) {
      log.trace('_parseRequest: params parsed as: %o', request.params);
    }

    return next();
  });

}


module.exports = {

  createServer: function(options) {

    var server = http.createServer(function(request, response) {
      assert.ok(request);
      assert.ok(response);

      _response = response;

      request.requestId = response.requestId = uuid();
      request._requireApiVersion = server._requireApiVersion;
      request._apiVersion = server._apiVersion;
      response._apiVersion = server._apiVersion;
      response._serverName = server._serverName;
      response.startTime = new Date().getTime();

      var route;
      var params;
      var i, k;
      var path = _sanitizePath(request.url);
      request.url = path;
      if (server.routes[request.method]) {
        var routes = server.routes[request.method];
        for (i = 0; i < routes.length; i++) {
          params = _matches(path, routes[i]);
          if (params) {
            route = routes[i];
            break;
          }
        }
      }

      if (route) {
        if (!request.params) request.params = {};
        for (k in params) {
          if (params.hasOwnProperty(k)) {
            assert.ok(!request.params.hasOwnProperty(k));
            request.params[k] = params[k];
          }
        }

        log.trace('request parameters now: %o', request.params);

        var _i = 0;
        _parseRequest(request, response, function() {
          var self = arguments.callee;
          if (route.handlers[_i]) {
            if (log.trace()) {
              log.trace('Running handler: %s:: %d', request.method, _i);
            }
            return route.handlers[_i++].call(this, request, response, self);
          } else {
            _response = null;
          }
        });
      } else {
        // if(route)
        // Try to send back a meaningful error code (e.g., method not supported
        // rather than just 404).
        // The only way we got here was if the method didn't match, so this
        // loop is solely to send back a 405 rather than a 404.  Sucks we have
        // to do an O(N^2) walk (I guess we could do a tree or something, but
        // bah, whatever, if you have that many urls...).
        var _code = 404;
        for (k in server.routes.urls) {
          if (server.routes.urls.hasOwnProperty(k)) {
            route = server.routes.urls[k];
            for (i = 0; i < route.length; i++) {
              if (_matches(path, route[i])) {
                _code = 405;
                break;
              }
            }
          }
        }

        response.send(_code);
        _response = null;
      }
    });

    server.logLevel = function(level) {
      return log.level(level);
    };

    server.routes = {};


    server._requireApiVersion = false;
    if (options) {
      if (options.apiVersion) {
        server._apiVersion = options.apiVersion;
      }
      if (options.serverName) {
        server._serverName = options.serverName;
      }
      if (options.requireApiVersion) {
        server._requireApiVersion = true;
      }
    }
    if (!server._apiVersion) {
      server._apiVersion = Constants.DefaultApiVersion;
    }
    if (!server._serverName) {
      server._serverName = Constants.DefaultServerName;
    }

    return server;
  },

  LogLevel: log.Level,
  log: log,
  newError: newError

};