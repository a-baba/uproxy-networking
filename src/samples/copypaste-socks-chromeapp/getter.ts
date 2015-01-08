Polymer({
  model: model,
  generateIceCandidates: function() {
    this.$.generateIceCandidatesButton.disabled = true;
    copypastePromise.then((copypaste:any) => { copypaste.emit('start', {}); });
  },
  parseInboundText: function() {
    if (model.usingCrypto && !model.decrypted) {
      decryptInboundMessage(model.inboundText);
    } else {
      parsedInboundMessages = parseInboundMessages(model.inboundText);
    }
  },
  consumeInboundText: function() {
    consumeInboundMessage();
    // Disable the form field, since it no longer makes sense to accept further
    // input in it.
    this.$.inboundMessageNode.disabled = true;
    // Disable the "Start Proxying" button after it's clicked.
    this.$.consumeMessageButton.disabled = true;
  },
  ready: function() {
    addTranslatedStrings(this);
  }
});
