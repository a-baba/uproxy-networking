/// <reference path='../../arraybuffers/arraybuffers.d.ts' />
/// <reference path="../../networking-typings/communications.d.ts" />
/// <reference path="../../rtc-to-net/rtc-to-net.d.ts" />
/// <reference path="../../socks-common/socks-headers.d.ts" />
/// <reference path="../../socks-to-rtc/socks-to-rtc.d.ts" />
/// <reference path="../../tcp/tcp.d.ts" />
/// <reference path="../../webrtc/peerconnection.d.ts" />

class ProxyIntegrationTest {
  constructor(private dispatchEvent_:(name:string, args:any) => void) {}

  private socksToRtc_ :SocksToRtc.SocksToRtc;
  private rtcToNet_ :RtcToNet.RtcToNet;
  private echoServer_ :Tcp.Server;

  private startEchoServer_ = () : Promise<Net.Endpoint> => {
    this.echoServer_ = new Tcp.Server({
      address: '127.0.0.1',
      port: 0
    });

    this.echoServer_.connectionsQueue.setSyncHandler((tcpConnection:Tcp.Connection) => {
      tcpConnection.dataFromSocketQueue.setSyncHandler((buffer:ArrayBuffer) => {
        tcpConnection.send(buffer);
      });
    });

    return this.echoServer_.listen();
  }

  private startSocksPair_ = () : Promise<Net.Endpoint> => {
    var socksToRtcEndpoint :Net.Endpoint = {
      address: '127.0.0.1',
      port: 0
    };
    var socksToRtcPcConfig :WebRtc.PeerConnectionConfig = {
      webrtcPcConfig: {iceServers: []},
      peerName: 'socks-to-rtc',  // Required because crypto.randomUint32 is not defined.
      initiateConnection: true
    };
    var rtcToNetPcConfig :WebRtc.PeerConnectionConfig = {
      webrtcPcConfig: {iceServers: []},
      peerName: 'rtc-to-net',
      initiateConnection: false
    };
    var rtcToNetProxyConfig :RtcToNet.ProxyConfig = {
      allowNonUnicast: true  // Allow RtcToNet to contact the localhost server.
    };

    this.socksToRtc_ = new SocksToRtc.SocksToRtc();
    this.rtcToNet_ = new RtcToNet.RtcToNet(rtcToNetPcConfig, rtcToNetProxyConfig);
    this.socksToRtc_.on('signalForPeer', this.rtcToNet_.handleSignalFromPeer);
    this.rtcToNet_.signalsForPeer.setSyncHandler(this.socksToRtc_.handleSignalFromPeer);
    return this.socksToRtc_.start(socksToRtcEndpoint, socksToRtcPcConfig);
  }

  // Assumes webEndpoint is IPv4.
  private connectThroughSocks_ = (socksEndpoint:Net.Endpoint, webEndpoint:Net.Endpoint) : Promise<Tcp.Connection> => {
    var connection = new Tcp.Connection({endpoint: socksEndpoint});
    var authRequest = Socks.composeAuthHandshakeBuffer([Socks.Auth.NOAUTH]);
    connection.send(authRequest);
    return connection.receiveNext().then((buffer:ArrayBuffer) : Promise<ArrayBuffer> => {
      var auth = Socks.interpretAuthResponse(buffer);
      if (auth != Socks.Auth.NOAUTH) {
        throw new Error('Unexpected auth value: ' + auth);
      }

      var request :Socks.Request = {
        version: Socks.VERSION5,
        command: Socks.Command.TCP_CONNECT,
        destination: {
          addressType: Socks.AddressType.IP_V4,
          endpoint: webEndpoint,
          addressByteLength: 7
        }
      };
      connection.send(Socks.composeRequestBuffer(request));
      return connection.receiveNext();
    }).then((buffer:ArrayBuffer) : Tcp.Connection => {
      var expectedBuffer = Socks.composeRequestResponse(webEndpoint);
      this.assertEqual_(buffer, expectedBuffer, 'compose request');
      return connection;
    });
  }

  public singleEchoTest = (contents:ArrayBuffer) : Promise<ArrayBuffer> => {
    try {
      return Promise.all([this.startSocksPair_(), this.startEchoServer_()])
          .then((endpoints:Net.Endpoint[]) : Promise<Tcp.Connection> => {
            var socksEndpoint = endpoints[0];
            var echoEndpoint = endpoints[1];
            return this.connectThroughSocks_(socksEndpoint, echoEndpoint);
          }).then((connection:Tcp.Connection) => {
            connection.send(contents);
            return connection.receiveNext();
          });
    } catch (e) {
      return Promise.reject(e.message + ' ' + e.stack);
    }
  }

  private assertEqual_ = (a:ArrayBuffer, b:ArrayBuffer, tag:string) : void => {
    if (a.byteLength != b.byteLength) {
      throw new Error(tag + ': length mismatch: ' +
                      a.byteLength + ' != ' + b.byteLength);
    }
    var aBytes = new Uint8Array(a);
    var bBytes = new Uint8Array(b);
    for (var i = 0; i < aBytes.length; ++i) {
      if (aBytes[i] != bBytes[i]) {
        throw new Error(tag + ': content mismatch at byte ' + i);
      }
    }
  }
}

interface Freedom {
  providePromises: (a:new (f:any) => ProxyIntegrationTest) => void;
};

if (typeof freedom !== 'undefined') {
  freedom().providePromises(ProxyIntegrationTest);
}