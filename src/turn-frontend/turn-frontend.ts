/// <reference path='../../../third_party/freedom-typings/freedom-common.d.ts' />
/// <reference path='../../../third_party/freedom-typings/udp-socket.d.ts' />
/// <reference path='../../../third_party/typings/es6-promise/es6-promise.d.ts' />

import arraybuffers = require('../../../third_party/uproxy-lib/arraybuffers/arraybuffers');

import messages = require('./messages');
import net = require('../net/net.types');

import logging = require('../../../third_party/uproxy-lib/logging/logging');
var log :logging.Log = new logging.Log('TURN frontend');

/**
 * A TURN server which delegates the creation and operation of relay sockets
 * to a separate "net" Freedom module. The separation is intended to
 * facilitate transformation of intra-process traffic, viz. obfuscation. The
 * intended use of this server is as a proxy for WebRTC traffic to provide,
 * when paired with a NAT-punching and obfuscated network transport, for
 * a hard-to-detect and hard-to-block peer-to-peer connection.
 *
 * Based on:
 *   http://www.ietf.org/rfc/rfc5766.txt
 *
 * While this server should behave as a regular TURN server, its normal
 * (and most tested!) configuration is as a relay for a single WebRTC data
 * channel, servicing just one client which is attempting to communicate
 * with a single remote host.
 *
 * As such, please note:
 *  - no attempt is made to model permissions (permission requests always
 *    succeed)
 *  - no attempt is made to model lifetime (allocations live for the
 *    lifetime of the server)
 *  - there's no support for channels (just send and data indications)
 *  - while the server does sign its responses with a MESSAGE-INTEGRITY
 *    attribute, it does not verify the client's signature
 *  - only the long-term credential mechanism is supported
 */
class Frontend {
  /** Socket on which the server is listening. */
  private socket_ :freedom_UdpSocket.Socket;

  // TODO: the following two maps are a code smell...needs a re-think

  /**
   * These are invoked when the remote side sends us a response
   * to a relay socket creation request.
   */
  private callbacks_:{[tag:string]:(response:messages.StunMessage) => void} = {};

  /**
   * These are fulfilled when the callback is invoked.
   */
  private promises_:{[s:string]:Promise<messages.StunMessage>} = {};

  // TODO: define a type for event dispatcher in freedom-typescript-api
  constructor (private dispatchEvent_ ?:(name:string, args:any) => void) {
    this.socket_ = freedom['core.udpsocket']();
  }

  /**
   * Returns a promise to create a socket, bind to the specified address, and
   * start listening for datagrams. Specify port zero to have the system
   * choose a free port.
   */
  public bind(address:string, port:number) : Promise<net.Endpoint> {
    return this.socket_.bind(address, port)
        .then((resultCode:number) => {
          if (resultCode != 0) {
            throw new Error('listen failed with result code ' + resultCode);
          }
          return resultCode;
        })
        .then(this.socket_.getInfo)
        .then((socketInfo:freedom_UdpSocket.SocketInfo) => {
          log.info('listening on ' + socketInfo.localAddress + ':' +
              socketInfo.localPort);
          this.socket_.on('onData', this.onData_);
          return {
            address: socketInfo.localAddress,
            port: socketInfo.localPort
          };
        });
  }

  /**
   * Called when data is received from a TURN client on our UDP socket.
   * Sends a response to the client, if one is required (send and data
   * indications are the exception). Note that the RFC states that any
   * message which cannot be handled or understood by the server should be
   * ignored.
   */
  private onData_ = (recvFromInfo:freedom_UdpSocket.RecvFromInfo) => {
    try {
      var stunMessage = messages.parseStunMessage(new Uint8Array(recvFromInfo.data));
      var clientEndpoint = {
        address: recvFromInfo.address,
        port: recvFromInfo.port
      };
      this.handleStunMessage(stunMessage, clientEndpoint)
          .then((response ?:messages.StunMessage) => {
            if (response) {
              var responseBytes = messages.formatStunMessageWithIntegrity(response);
              this.socket_.sendTo(
                  responseBytes.buffer,
                  recvFromInfo.address,
                  recvFromInfo.port);
            }
          }, (e) => {
            log.error('error handling STUN message: ' + e.message);
          });
    } catch (e) {
      log.warn('failed to parse STUN message from ' +
          recvFromInfo.address  + ':' + recvFromInfo.port);
    }
  }

  /**
   * Resolves to the response which should be sent to the client, or undefined
   * if none is required, e.g. for send indications. Rejects if the STUN
   * method is unsupported or there is an error handling the message.
   * Public for testing.
   */
  public handleStunMessage = (
      stunMessage:messages.StunMessage,
      clientEndpoint:net.Endpoint) : Promise<messages.StunMessage> => {
    if (stunMessage.method == messages.MessageMethod.ALLOCATE) {
      return this.handleAllocateRequest_(stunMessage, clientEndpoint);
    } else if (stunMessage.method == messages.MessageMethod.CREATE_PERMISSION) {
      return this.handleCreatePermissionRequest_(stunMessage);
    } else if (stunMessage.method == messages.MessageMethod.REFRESH) {
      return this.handleRefreshRequest_(stunMessage);
    } else if (stunMessage.method == messages.MessageMethod.SEND) {
      return this.handleSendIndication_(stunMessage, clientEndpoint);
    }
    return Promise.reject(new Error('unsupported STUN method ' +
        (messages.MessageMethod[stunMessage.method] || stunMessage.method)));
  }

  /**
   * Resolves to a success response. Since we don't actually track
   * permissions, this is pretty straightforward.
   */
  private handleCreatePermissionRequest_ = (
      request:messages.StunMessage) : Promise<messages.StunMessage> => {
    return Promise.resolve({
      method: messages.MessageMethod.CREATE_PERMISSION,
      clazz: messages.MessageClass.SUCCESS_RESPONSE,
      transactionId: request.transactionId,
      attributes: <messages.StunAttribute[]>[]
    });
  }

  /**
   * Resolves to a success response. REFRESH messages don't seem to be
   * required by Chrome (at least for establishing data channels) but are
   * required by turnutils_uclient.
   */
  private handleRefreshRequest_ = (
      request:messages.StunMessage) : Promise<messages.StunMessage> => {
    return Promise.resolve({
      method: messages.MessageMethod.REFRESH,
      clazz: messages.MessageClass.SUCCESS_RESPONSE,
      transactionId: request.transactionId,
      attributes: [{
          type: messages.MessageAttribute.LIFETIME,
          value: new Uint8Array([0x00, 0x00, 600 >> 8, 600 & 0xff]) // 600 = ten mins
        }]
    });
  }

  /**
   * Resolves to an ALLOCATE response, which will be a FAILURE_RESPONSE or
   * SUCCESS_RESPONSE depending on whether the request includes a username
   * attribute and whether a relay socket can be created on the remote side.
   *
   * Note that there are two classes of ALLOCATE requests:
   *  1. The first is the very first request sent by the client to a TURN
   *     server to which the server should always respond with a *failure*
   *     response which *also* contains attributes (notably realm) which
   *     the client can include in subsequent ALLOCATE requests.
   *  2. In the second case, the client includes REALM, USERNAME, and
   *     MESSAGE-INTEGRITY attributes and the server creates a relay socket
   *     before responding to the client.
   *
   * Right now, the server has no real notion of usernames and realms so we
   * are just performing the dance that TURN clients expect, using the
   * presence of a USERNAME attribute to distinguish the first case from the
   * second.
   *
   * Section 10.2 outlines the precise behaviour required:
   *   http://tools.ietf.org/html/rfc5389#section-10.2
   */
  private handleAllocateRequest_ = (
      request:messages.StunMessage,
      clientEndpoint:net.Endpoint) : Promise<messages.StunMessage> => {
    // If no USERNAME attribute is present then assume this is the client's
    // first interaction with the server and respond immediately with a
    // failure message, including REALM information for subsequent requests.
    try {
      messages.findFirstAttributeWithType(
          messages.MessageAttribute.USERNAME,
          request.attributes);
    } catch (e) {
      return Promise.resolve({
        method: messages.MessageMethod.ALLOCATE,
        clazz: messages.MessageClass.FAILURE_RESPONSE,
        transactionId: request.transactionId,
        attributes: [{
          type: messages.MessageAttribute.ERROR_CODE,
          value: messages.formatErrorCodeAttribute(401, 'not authorised')
        }, {
          type: messages.MessageAttribute.NONCE,
          value: new Uint8Array(arraybuffers.stringToArrayBuffer('nonce'))
        }, {
          type: messages.MessageAttribute.REALM,
          value: new Uint8Array(arraybuffers.stringToArrayBuffer(messages.REALM))
        }]
      });
    }

    // If we haven't already done so, create a callback which will be invoked
    // when the remote side sends us a response to our relay socket request.
    var tag = clientEndpoint.address + ':' + clientEndpoint.port;
    var promise :Promise<messages.StunMessage>;
    if (tag in this.promises_) {
      promise = this.promises_[tag];
    } else {
      promise = new Promise((F,R) => {
        this.callbacks_[tag] = (response:messages.StunMessage) => {
          if (response.clazz === messages.MessageClass.SUCCESS_RESPONSE) {
            log.debug('relay socket allocated for TURN client ' +
                clientEndpoint.address + ':' + clientEndpoint.port);
            F(response);
          } else {
            R(new Error('could not allocate relay socket for TURN client ' +
                clientEndpoint.address + ':' + clientEndpoint.port));
          }
        };
      });
      this.promises_[tag] = promise;
    }

    // Request a new relay socket.
    // TODO: minimise the number of attributes sent
    this.emitIpc_(request, clientEndpoint);

    // Fulfill, once our relay socket callback has been invoked.
    return promise;
  }

  /**
   * Makes a request to the remote side to send a datagram on the client's
   * relay socket.
   */
  private handleSendIndication_ = (
      request:messages.StunMessage,
      clientEndpoint:net.Endpoint) : Promise<messages.StunMessage> => {
    this.emitIpc_(request, clientEndpoint);
    return Promise.resolve(undefined);
  }

  /**
   * Emits a Freedom message which should be relayed to the remote side.
   * The message is a STUN message, as received from a TURN client but with
   * the addition of an IPC_TAG attribute identifying the TURN client.
   */
  private emitIpc_ = (
      stunMessage:messages.StunMessage,
      clientEndpoint:net.Endpoint) : void => {
    stunMessage.attributes.push({
      type: messages.MessageAttribute.IPC_TAG,
      value: messages.formatXorMappedAddressAttribute(
          clientEndpoint.address, clientEndpoint.port)
    });
    this.dispatchEvent_('ipc', {
      data: messages.formatStunMessage(stunMessage).buffer
    });
  }

  /**
   * Handles a Freedom message from the remote side.
   */
  public handleIpc = (data :ArrayBuffer) : Promise<void> => {
    var stunMessage :messages.StunMessage;
    try {
      stunMessage = messages.parseStunMessage(new Uint8Array(data));
    } catch (e) {
      return Promise.reject(new Error(
          'failed to parse STUN message from IPC channel'));
    }

    // With which client is this message associated?
    var clientEndpoint :net.Endpoint;
    try {
      var ipcAttribute = messages.findFirstAttributeWithType(
          messages.MessageAttribute.IPC_TAG,
          stunMessage.attributes);
      try {
        clientEndpoint = messages.parseXorMappedAddressAttribute(
            ipcAttribute.value);
      } catch (e) {
        return Promise.reject(new Error(
            'could not parse address in IPC_TAG attribute: ' + e.message));
      }
    } catch (e) {
      return Promise.reject(new Error(
          'message received on IPC channel without IPC_TAG attribute'));
    }
    var tag = clientEndpoint.address + ':' + clientEndpoint.port;

    if (stunMessage.method == messages.MessageMethod.ALLOCATE) {
      // A response from one of our relay socket creation requests.
      // Invoke the relevant callback.
      // TODO: check callback exists
      var callback = this.callbacks_[tag];
      callback(stunMessage);
    } else if (stunMessage.method == messages.MessageMethod.DATA) {
      // The remote side received data on a relay socket.
      // Forward it to the relevant client.
      // TODO: consider removing the IPC_TAG attribute
      this.socket_.sendTo(
        data,
        clientEndpoint.address,
        clientEndpoint.port);
    } else {
      return Promise.reject(new Error(
          'unsupported IPC method: ' + stunMessage.method));
    }
    return Promise.resolve<void>();
  }
}

export = Frontend;
