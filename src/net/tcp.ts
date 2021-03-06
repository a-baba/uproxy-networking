/// <reference path='../../../third_party/typings/es6-promise/es6-promise.d.ts' />
/// <reference path='../../../third_party/freedom-typings/freedom-common.d.ts' />
/// <reference path='../../../third_party/freedom-typings/freedom-module-env.d.ts' />
/// <reference path='../../../third_party/freedom-typings/tcp-socket.d.ts' />

/*
 * This is a TCP server based on Freedom's sockets API.
 */

import logging = require('../../../third_party/uproxy-lib/logging/logging');
import handler = require('../../../third_party/uproxy-lib/handler/queue');
import net = require('./net.types');

var log :logging.Log = new logging.Log('tcp');

// Code for how a Tcp Connection is closed.
export enum SocketCloseKind {
  WE_CLOSED_IT,
  REMOTELY_CLOSED,
  NEVER_CONNECTED,
  UNKOWN
}

export interface ConnectionInfo {
  bound  ?:net.Endpoint;
  remote ?:net.Endpoint;
}

// A limit on the max number of TCP connections before we start rejecting
// new ones.
var DEFAULT_MAX_CONNECTIONS = 1048576;

// Private function, exported only for unit tests
export function endpointOfSocketInfo(info:freedom_TcpSocket.SocketInfo)
    : ConnectionInfo {
  var retval :ConnectionInfo = {};
  if (typeof info.localAddress == 'string' &&
      typeof info.localPort == 'number') {
    retval.bound = {
      address: info.localAddress,
      port: info.localPort
    };
  }
  if (typeof info.peerAddress == 'string' &&
      typeof info.peerPort == 'number') {
    retval.remote = {
      address: info.peerAddress,
      port: info.peerPort
    };
  }
  return retval;
}

// A static helper function to close a freedom socket object and then
// appropriately deallocate it's interface object.
function destroyFreedomSocket_(socket:freedom_TcpSocket.Socket)
    : Promise<void> {
  // Note that :
  // freedom['core.tcpsocket'].close != freedom['core.tcpsocket']().close
  // The former destroys the freedom interface & communication channels.
  // The latter is a method on the constructed interface object that is on
  // the instance of the freedom tcp-socket's API.
  return socket.close().then(
    () => { freedom['core.tcpsocket'].close(socket); },
    (e) => { freedom['core.tcpsocket'].close(socket); return e; });
}

// Tcp.Server: a TCP Server. This listens for connections when listen is
// called, and handles the new connection as specified by the onConnection
// argument to the constructor.
export class Server {
  private serverSocket_ :freedom_TcpSocket.Socket;
  // TODO: index by connectionId not socketID. More stable & string based.
  private conns:{[socketId:number] : Connection} = {};

  public connectionsQueue :handler.Queue<Connection, void>;

  // The address and port that the tcp server is told to listening on. The
  // initial assignment may set the port to 0, which indicates that the port
  // is being dynamically allocated. When the port is actually assigned
  // (right before the listen promise fulfills), the endpoint is set to the
  // port that is actually being listened on.
  private endpoint_ :net.Endpoint;

  // The |onceShutdown| promise is fulfilled when the server is shutdown and
  // no longer listening.
  private onceShutdown_ :Promise<void>;
  public onceShutdown = () : Promise<void> => { return this.onceShutdown_; }
  // isShutdown can become true, but never false again. It gives synchronous
  // access to test if |onceShutdown_| fulfilled.
  private isShutdown_ :boolean = false;
  public isShutdown = () : boolean => { return this.isShutdown_; }

  private onceListening_ :Promise<net.Endpoint>;
  public onceListening = () : Promise<net.Endpoint> => {
    return this.onceListening_;
  }
  private fulfillListening_ :(endpoint:net.Endpoint) => void;
  private isListening_ :boolean = false;
  public isListening = () : boolean => { return this.isListening_; };

  // Create TCP server.
  // `endpoint` = Address and port to be listening on. Port 0 is used for
  // dynamic port allocation.
  // `port` = the port to listen on; 0 = dynamic allocation.
  // `onConnection` = the handler for new TCP Connections.
  // `maxConnections` = the number of connections after which all new ones
  // will be closed as soon as they connect.
  constructor(endpoint :net.Endpoint,
              public maxConnections ?:number) {
    this.endpoint_ = endpoint;
    this.maxConnections = maxConnections || DEFAULT_MAX_CONNECTIONS;
    this.serverSocket_ = freedom['core.tcpsocket']();
    // When `serverSocket_` gets new connections, handle them. This only
    // happens after the server's listen function is called.
    this.serverSocket_.on('onConnection', this.onConnectionHandler_);
    this.connectionsQueue = new handler.Queue<Connection, void>();
    this.onceShutdown_ = new Promise<void>((F,R) => {
      this.serverSocket_.on('onDisconnect', () => {
        F();
        this.isShutdown_ = true;
      });
    });
    this.onceListening_ = new Promise<net.Endpoint>((F,R) => {
      this.fulfillListening_ = F;
    });
  }

  // CONSIDER: use a generic util class for better object management, e.g.
  // below should just be return conns.values().
  public connections = () => {
    var allConnectionsList : Connection[] = [];
    for (var i in this.conns) { allConnectionsList.push(this.conns[i]); }
    return allConnectionsList;
  }

  public connectionsCount = () => {
    return Object.keys(this.conns).length;
  }


  // Listens on the serverSocket_ to `address:port` for new TCP connections.
  // Returns a Promise that this server is now listening with the endpoint it
  // is listening on. If 0 was passed as the port, a dynamic port is chosen.
  public listen = () : Promise<net.Endpoint> => {
    if (this.isShutdown_) {
      return Promise.reject(new Error('Cannot listen on a shutdown server.'));
    }
    return this.serverSocket_.listen(this.endpoint_.address,
                                     this.endpoint_.port)
        .then(this.serverSocket_.getInfo)
        .then((info : freedom_TcpSocket.SocketInfo) => {
          this.endpoint_ = { address: info.localAddress,
                             port: info.localPort };
          this.fulfillListening_(this.endpoint_);
          this.isListening_ = true;
          return this.endpoint_;
        });
  }

  // onConnectionHandler_ is more or less TCP Accept: it is called when a new
  // TCP connection is established.
  private onConnectionHandler_ =
      (acceptValue:freedom_TcpSocket.ConnectInfo) : void => {
    var socketId = acceptValue.socket;

    // Check that we haven't reach the maximum number of connections
    var connectionsCount = Object.keys(this.conns).length;
    if (connectionsCount >= this.maxConnections) {
      // Stop too many connections.  We create a new socket here from the
      // incoming Id and immediately close it, because we don't yet have a
      // reference to the incomming socket.
      destroyFreedomSocket_(freedom['core.tcpsocket'](socketId));
      //log.error('Too many connections: ' + connectionsCount);
      return;
    }

    // Create new connection.
    //log.debug('Tcp.Server accepted connection on socket id ' + socketId);
    var conn = new Connection({existingSocketId:socketId});
    // When the connection is disconnected correctly, or by error, remove
    // from the server's list of connections.
    conn.onceClosed.then(
      () => {
        delete this.conns[socketId];
        //log.debug('Tcp.Server(' + JSON.stringify(this.endpoint) +
        //    ') : connection closed (' + socketId + '). Conn Count: ' +
        //    Object.keys(this.conns).length + ']');
      },
      (e) => {
        delete this.conns[socketId];
        //log.warn('Tcp.Server(' + JSON.stringify(this.endpoint) +
        //    ') : connection closed by error (' + socketId + '): ' +
        //    e.toString() + ' . Conn Count: ' +
        //    Object.keys(this.conns).length + ']');
      })
    this.conns[socketId] = conn;
    //log.debug(this.toString());
    this.connectionsQueue.handle(conn);
  }

  // Mostly useful fro debugging
  public toString = () : string => {
    var s = 'Tcp.Server(' + JSON.stringify(this.endpoint_) +
        ') connections: ' + Object.keys(this.conns).length + '\n{';
    for(var socketId in this.conns) {
      s += '  ' + this.conns[socketId].toString() + '\n';
    }
    return s += '}';
  }

  // Closes all active connections.
  public closeAll = () : Promise<void> => {
    var allPromises :Promise<SocketCloseKind>[] = [];

    // Close all Tcp connections.
    for (var i in this.conns) {
      var c = this.conns[i];
      allPromises.push(c.close());
    }

    // Wait for all promises to complete.
    return Promise.all(allPromises).then(() => {
      //log.debug('successfully closed all Tcp Connections.');
    });
  }

  public stopListening = () : Promise<void> => {
    // Close the server socket. Note: freedom doesn't give a socket Id for a
    // listening socket, so we just pass 0 back here: it's only for
    // debugging/console logging, so it doesn't matter.
    return destroyFreedomSocket_(this.serverSocket_).then(() => {
      this.isListening_ = false;
    })
    //.then(() => {
      //log.debug('successfully stopped listening for more connections.');
    //});
  }

  public shutdown = () : Promise<void> => {
    // This order is important: make sure no new connections happen while
    // we're trying to close all the connections.
    return this.stopListening().then(this.closeAll);
  }
}  // class Tcp.Server

// Tcp.Connection - Manages up a single TCP connection.
export class Connection {
  // Unique identifier for each connection.
  private static globalConnectionId_ :number = 0;

  // Promise for when this connection is closed.
  public onceConnected :Promise<ConnectionInfo>;
  public onceClosed :Promise<SocketCloseKind>;
  // Queue of data to be handled, and the capacity to set a handler and
  // handle the data.
  public dataFromSocketQueue :handler.Queue<ArrayBuffer,void>;
  public dataToSocketQueue :handler.Queue<ArrayBuffer, freedom_TcpSocket.WriteInfo>;

  // Public unique connectionId.
  public connectionId :string;

  // isClosed() === state_ === Connection.State.CLOSED iff onceClosed
  // has been rejected or fulfilled. We use isClosed to ensure that we only
  // fulfill/reject the onceDisconnectd once.
  private state_ :Connection.State;
  // The underlying Freedom TCP socket.
  private connectionSocket_ :freedom_TcpSocket.Socket;
  // A private function called to invoke fullfil onceClosed.
  private fulfillClosed_ :(reason:SocketCloseKind)=>void;

  // A TCP connection for a given socket.
  constructor(connectionKind:Connection.Kind, private startPaused_?:boolean) {
    this.connectionId = 'N' + Connection.globalConnectionId_++;

    this.dataFromSocketQueue = new handler.Queue<ArrayBuffer,void>();
    this.dataToSocketQueue =
        new handler.Queue<ArrayBuffer,freedom_TcpSocket.WriteInfo>();

    if(Object.keys(connectionKind).length !== 1) {
      //log.error(this.connectionId + ': Bad New Tcp Connection Kind:' +
      //       JSON.stringify(connectionKind));
      this.state_ = Connection.State.ERROR;
      this.onceConnected =
          Promise.reject(new Error(
              this.connectionId + 'Bad New Tcp Connection Kind:' +
              JSON.stringify(connectionKind)));
      this.onceClosed = Promise.resolve(SocketCloseKind.NEVER_CONNECTED);
      return;
    }

    if(connectionKind.existingSocketId) {
      // If we already have an open socket; i.e. from a previous tcp listen.
      // So we get a handler to the old freedom socket.
      this.connectionSocket_ =
          freedom['core.tcpsocket'](connectionKind.existingSocketId);
      this.onceConnected =
          this.connectionSocket_.getInfo().then(endpointOfSocketInfo);
      this.state_ = Connection.State.CONNECTED;
      this.connectionId = this.connectionId + '.A' +
          connectionKind.existingSocketId;
    } else if (connectionKind.endpoint) {
      // Create a new tcp socket to the given endpoint.
      this.connectionSocket_ = freedom['core.tcpsocket']();
      // We don't declare ourselves connected until we know the IP address to
      // which we have connected.  To speed this process up, we immediately
      // pause the socket as soon as it's connected, so that CPU time is not
      // wasted sending events that we can't pass on until getInfo returns.
      this.onceConnected =
          this.connectionSocket_
              .connect(connectionKind.endpoint.address,
                       connectionKind.endpoint.port)
              .then(this.pause)
              .then(this.connectionSocket_.getInfo)
              .then((info:freedom_TcpSocket.SocketInfo) => {
                if (!this.startPaused_) {
                  this.resume();
                }
                return endpointOfSocketInfo(info);
              })
      this.state_ = Connection.State.CONNECTING;
      this.onceConnected
          .then(() => {
            // We need this guard because the getInfo call is async and a
            // close may happen affter the freedom socket connects and the
            // getInfo completes.
            if(this.state_ !== Connection.State.CLOSED) {
              this.state_ = Connection.State.CONNECTED;
            }
          });
    } else {
      throw(new Error(this.connectionId +
          ': Should be impossible connectionKind' +
          JSON.stringify(connectionKind)));
    }

    // Use the dataFromSocketQueue handler for data from the socket.
    this.connectionSocket_.on('onData',
        (readInfo:freedom_TcpSocket.ReadInfo) : void => {
      this.dataFromSocketQueue.handle(readInfo.data);
    });

    this.onceClosed = new Promise<SocketCloseKind>((F, R) => {
      this.fulfillClosed_ = F;
    });

    // Once we are connected, we start sending data to the underlying socket.
    // |dataToSocketQueue| allows a class using this connection to start
    // queuing data to be send to the socket.
    this.onceConnected.then(() => {
      this.dataToSocketQueue.setHandler(this.connectionSocket_.write);
    });
    this.onceConnected.catch((e:Error) => {
      this.fulfillClosed_(SocketCloseKind.NEVER_CONNECTED);
    });

    this.connectionSocket_.on('onDisconnect', this.onDisconnectHandler_);
  }

  // Receive returns a promise for exactly the next |ArrayBuffer| of data.
  public receiveNext = () : Promise<ArrayBuffer> => {
    return new Promise((F,R) => {
      this.dataFromSocketQueue.setSyncNextHandler(F).catch(R);
    });
  }

  // Invoked when the socket is closed for any reason.
  // Fulfills onceClosed.
  private onDisconnectHandler_ = (info:freedom_TcpSocket.DisconnectInfo) : void => {
    log.debug('%1: onDisconnect: %2', [
        this.connectionId,
        JSON.stringify(info)]);

    if (this.state_ === Connection.State.CLOSED) {
      log.warn('%1: Got onDisconnect in closed state', [this.connectionId]);
      return;
    }

    this.state_ = Connection.State.CLOSED;
    this.dataToSocketQueue.stopHandling();
    this.dataToSocketQueue.clear();

    // CONSIDER: can this happen after a onceConnected promise rejection? if so,
    // do we want to preserve the SocketCloseKind.NEVER_CONNECTED result for
    // onceClosed?
    destroyFreedomSocket_(this.connectionSocket_).then(() => {
      if (info.errcode === 'SUCCESS') {
        this.fulfillClosed_(SocketCloseKind.WE_CLOSED_IT);
      } else if (info.errcode === 'CONNECTION_CLOSED') {
        this.fulfillClosed_(SocketCloseKind.REMOTELY_CLOSED);
      } else {
        this.fulfillClosed_(SocketCloseKind.UNKOWN);
      }
    });
  }

  public pause = () => {
    this.connectionSocket_.pause();
  }

  public resume = () => {
    this.connectionSocket_.resume();
  }

  // This is called to close the underlying socket. This fulfills the
  // disconnect Promise `onceDisconnected`.
  public close = () : Promise<SocketCloseKind> => {
    log.debug('%1: close', [this.connectionId]);

    if (this.state_ === Connection.State.CLOSED) {
      log.debug('%1: close called when already closed', [
          this.connectionId]);
    } else {
      this.connectionSocket_.close();
    }

    // The onDisconnect handler (which should only
    // be invoked once) actually stops handling, fulfills
    // onceClosed, etc.
    return this.onceClosed;
  }

  // Boolean function to check if this connection is closed;
  public isClosed = () : boolean => {
    return this.state_ === Connection.State.CLOSED;
  };
  public getState = () : Connection.State => {
    return this.state_;
  };

  /**
   * Sends a message that is pre-formatted as an arrayBuffer.
   */
  public send = (msg :ArrayBuffer) : Promise<freedom_TcpSocket.WriteInfo> => {
    return this.dataToSocketQueue.handle(msg);
  }

  public toString = () => {
    return 'Tcp.Connection(' + this.connectionId + ':' + Connection.State[this.state_] + ')';
  }

}  // class Tcp.Connection

// Static stuff for the Connection class.
export module Connection {
  // Exactly one of the arguments must be specified.
  export interface Kind {
    // To wrap up a connection for an existing socket
    existingSocketId ?:number;
    // TO create a new TCP connection to this target address and port.
    endpoint         ?:net.Endpoint;
  }

  // Describes the state of a connection.
  export enum State {
    ERROR, // Cannot change state.
    CONNECTING, // Can change to ERROR or CONNECTED.
    CONNECTED, // Can change to ERROR or CLOSED.
    CLOSED // Cannot change state.
  }
} // module Connection
