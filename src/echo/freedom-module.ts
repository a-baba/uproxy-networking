/// <reference path='../../../third_party/freedom-typings/freedom-module-env.d.ts' />

// TODO: smarter encapsulation logic for echo server; this file, along with the
// freedom-module.json file could be automatically generated by the IDL
// compiler.

import TcpEchoServer = require('./tcp-echo-server');
import net = require('../net/net.types');

// Example of how to add custom setting for the logging controller's filtering.
freedom['loggingcontroller']().setConsoleFilter(['*:D']);

// The underlying TCP echo server.
var tcpServer :TcpEchoServer;

// The parent freedom module which can send us events.
var parentModule = freedom();

parentModule.on('start', (endpoint:net.Endpoint) => {
  if(tcpServer) { tcpServer.server.closeAll(); }
  tcpServer = new TcpEchoServer(endpoint);
});

parentModule.on('stop', () => {
  if(tcpServer) { tcpServer.server.closeAll(); tcpServer = null; }
});
