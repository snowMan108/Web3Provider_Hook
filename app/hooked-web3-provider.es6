var factory = function(web3) {

  class HookedWeb3Provider extends web3.providers.HttpProvider {
    constructor({host, transaction_signer}) {
      super(host);
      this.transaction_signer = transaction_signer;

      // Cache of the most up to date transaction counts (nonces) for each address
      // encountered by the web3 provider that's managed by the transaction signer.
      this.global_nonces = {};
    }

    // We can't support *all* synchronous methods because we have to call out to
    // a transaction signer. So removing the ability to serve any.
    send(payload) {
      var requests = payload;
      if (!(requests instanceof Array)) {
        requests = [requests];
      }

      for (var request of requests) {
        if (request.method == "eth_sendTransaction") {
          throw new Error("HookedWeb3Provider does not support synchronous transactions. Please provide a callback.")
        }
      }

      var finishedWithRewrite = () => {
        super.send(payload, callback);
      };

      this.rewritePayloads(0, requests, {}, finishedWithRewrite);
    }

    // Catch the requests at the sendAsync level, rewriting all sendTransaction
    // methods to sendRawTransaction, calling out to the transaction_signer to
    // get the data for sendRawTransaction.
    sendAsync(payload, callback) {
      var finishedWithRewrite = () => {
        super.sendAsync(payload, callback);
      };

      var requests = payload;

      if (!(payload instanceof Array)) {
        requests = [payload];
      }

      this.rewritePayloads(0, requests, {}, finishedWithRewrite);
    }

    // Rewrite all eth_sendTransaction payloads in the requests array.
    // This takes care of batch requests, and updates the nonces accordingly.
    rewritePayloads(index, requests, session_nonces, finished) {
      if (index >= requests.length) {
        finished();
        return;
      }

      var payload = requests[index];

      // Function to remove code duplication for going to the next payload
      var next = (err) => {
        if (err != null) {
          finished(err);
          return;
        }
        this.rewritePayloads(index + 1, requests, session_nonces, finished);
      };

      // If this isn't a transaction we can modify, ignore it.
      if (payload.method != "eth_sendTransaction") {
        next();
        return;
      }

      var tx_params = payload.params[0];
      var sender = tx_params.from;

      this.transaction_signer.hasAddress(sender, (err, has_address) => {
        if (err != null || has_address == false) {
          next(err);
          return;
        }

        // Get the nonce, requesting from web3 if we haven't already requested it in this session.
        // Remember: "session_nonces" is the nonces we know about for this batch of rewriting (this "session").
        //           Having this cache makes it so we only need to call getTransactionCount once per batch.
        //           "global_nonces" is nonces across the life of this provider.
        var getNonce = (done) => {
          // If a nonce is specified in our nonce list, use that nonce.
          var nonce = session_nonces[sender];
          if (nonce != null) {
            done(null, nonce);
          } else {
            // Include pending transactions, so the nonce is set accordingly.
            // Note: "pending" doesn't seem to take effect for some Ethereum clients (geth),
            // hence the need for global_nonces.
            web3.eth.getTransactionCount(sender, "pending", function(err, new_nonce) {
              if (err != null) {
                done(err);
              } else {
                done(null, new_nonce.valueOf());
              }
            });
          }
        };

        // Get the nonce, requesting from web3 if we need to.
        // We then store the nonce and update it so we don't have to
        // to request from web3 again.
        getNonce((err, nonce) => {
          if (err != null) {
            finished(err);
            return;
          }

          // Set the expected nonce, and update our caches of nonces.
          // Note that if our session nonce is lower than what we have cached
          // across all transactions (and not just this batch) use our cached
          // version instead, even if
          var final_nonce = Math.max(nonce, this.global_nonces[sender] || 0);

          // Update the transaction parameters.
          tx_params.nonce = web3.toHex(final_nonce);

          // Update caches.
          session_nonces[sender] = final_nonce + 1;
          this.global_nonces[sender] = final_nonce + 1;

          // If our transaction signer does represent the address,
          // sign the transaction ourself and rewrite the payload.
          this.transaction_signer.signTransaction(tx_params, function(err, raw_tx) {
            if (err != null) {
              next(err);
              return;
            }

            payload.method = "eth_sendRawTransaction";
            payload.params = [raw_tx];
            next();
          });
        });
      });
    }
  }

  return HookedWeb3Provider;
};

var module = module || undefined;
if (module != null) {
  module.exports = factory(require("web3"));
} else {
  window.HookedWeb3Provider = factory(web3);
}
