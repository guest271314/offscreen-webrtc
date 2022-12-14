// ServiceWorker
if (
  self.serviceWorker instanceof ServiceWorker &&
  location.href === chrome.runtime.getURL('background.js')
) {
  let localResolve;
  let localPromise;
  let remoteResolve;
  let remotePromise;
  globalThis.signaling = {
    remote: null,
    local: null,
  };
  const setExternallyConnectable = async (
    set_externally_connectable = ['https://example.com/*'],
    unset_externally_connectable = false,
    extension_name
  ) => {
    return new Promise(async (resolve) => {
      let permission = await navigator.permissions.request({
        name: 'notifications',
      });
      if (permission.state === 'granted') {
        const saveFileNotification = new Notification(`Update extension?`, {
          body:
            `Select ${extension_name} extension directory ` +
            `to set ${location.origin} "externally_connectable" in manifest.json.`,
        });
        saveFileNotification.onclick = async (e) => {
          // Set Array of origins "externally_connectable" in manifest.json
          const dir = await showDirectoryPicker({
            mode: 'readwrite',
          });
          const fileHandle = await dir.getFileHandle('manifest.json', {
            create: false,
          });
          const file = await fileHandle.getFile();
          const text = await file.text();
          const manifest_json = JSON.parse(text);
          manifest_json.externally_connectable.matches = [
            ...new Set(
              unset_externally_connectable
                ? set_externally_connectable
                : [
                    ...manifest_json.externally_connectable.matches,
                    ...set_externally_connectable,
                  ]
            ),
          ];
          const writer = await fileHandle.createWritable({
            keepExistingData: false,
          });
          await writer.write(JSON.stringify(manifest_json, null, 2));
          await writer.close();
          await writer.closed;
          resolve(e.type);
        };
      }
    });
  };
  // Web page
  async function connectDataChannels(id) {
    let resolve;
    const port = chrome.runtime.connect(id, {
      name: 'local',
    });
    const local = new RTCPeerConnection({
      sdpSemantics: 'unified-plan',
    });
    [
      'onsignalingstatechange',
      'oniceconnectionstatechange',
      'onicegatheringstatechange',
    ].forEach((e) => local.addEventListener(e, console.log));

    local.onicecandidate = async (e) => {
      if (!e.candidate) {
        if (local.localDescription.sdp.indexOf('a=end-of-candidates') === -1) {
          local.localDescription.sdp += 'a=end-of-candidates\r\n';
        }
        try {
          port.postMessage({
            local: true,
            sdp: local.localDescription.sdp,
          });
          await new Promise((resolve) => {
            const handleMessage = (message) => {
              port.onMessage.removeListener(handleMessage);
              resolve();
            };
            port.postMessage('get-local');
          });
        } catch (e) {
          console.error(e);
        }
      }
    };
    const channel = local.createDataChannel('transfer', {
      negotiated: true,
      id: 0,
      binaryType: 'arraybuffer',
      protocol: 'raw',
    });

    channel.onopen = async (e) => {
      console.log(e.type);
    };
    channel.onclose = async (e) => {
      console.log(e.type);
    };
    channel.onclosing = async (e) => {
      console.log(e.type);
    };
    channel.onmessage = async (e) => {
      // Do stuff with data
      console.log(e.data);
    };

    try {
      const sdp = await new Promise((resolve) => {
        const handleMessage = (message) => {
          port.onMessage.removeListener(handleMessage);
          resolve(message.sdp);
        };
        port.onMessage.addListener(handleMessage);
        port.postMessage('get-remote');
      });
      await local.setRemoteDescription({
        type: 'offer',
        sdp,
      });
      const answer = await local.createAnswer();
      local.setLocalDescription(answer);
    } catch (e) {
      console.error(e);
    }
  }
  async function closeOffscreen({ reason }) {
    console.log(reason);
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
    const dir = await navigator.storage.getDirectory();
    if (!(await dir.values().next()).done) {
      const fileHandle = await dir.getFileHandle('update_manifest.txt');
      const file = await fileHandle.getFile();
      const id = await file.text();
      const tab = await chrome.tabs.get(Number(id));
      await dir.removeEntry('update_manifest.txt');
      await handleClick(tab);
    }
  }

  function handleSignaling(port) {
    globalThis.signaling.local = port;
    globalThis.signaling.remote = chrome.runtime.connect(chrome.runtime.id, {
      name: 'remote',
    });
    globalThis.signaling.remote.onMessage.addListener(async (message) => {
      remoteResolve(message);
    });

    globalThis.signaling.local.onMessage.addListener(async (message) => {
      if (message.local) {
        localResolve(message);
      }
      if (message === 'get-local') {
        const answer = await localPromise;
        globalThis.signaling.remote.postMessage(answer);
      }
      if (message === 'get-remote') {
        const answer = await remotePromise;
        // console.log(answer);
        globalThis.signaling.local.postMessage(answer);
      }
    });
  }

  async function handleClick(tab) {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
    const url = new URL(tab.url);
    const manifest = chrome.runtime.getManifest();
    console.log(url.origin, manifest.externally_connectable);
    const dir = await navigator.storage.getDirectory();
    console.log(
      !manifest.externally_connectable.matches.some((match) =>
        match.includes(url.origin)
      )
    );
    if (
      !manifest.externally_connectable.matches.some((match) =>
        match.includes(url.origin)
      )
    ) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
        },
        world: 'MAIN',
        // Unset all "externally_connectable"  [[], true, '']
        args: [[`${url.origin}/*`], false, manifest.name],
        func: setExternallyConnectable,
      });
      if (result === 'click') {
        // console.log(result);
        const fileHandle = await dir.getFileHandle('update_manifest.txt', {
          create: true,
        });
        const writable = await fileHandle.createWritable();
        await new Blob([tab.id]).stream().pipeTo(writable);
        chrome.runtime.reload();
      } else {
        if (!(await dir.values().next()).done) {
          await dir.removeEntry('update_manifest.txt');
        }
      }
    } else {
      chrome.runtime.onConnectExternal.addListener(handleSignaling);

      localPromise = new Promise((_) => (localResolve = _));
      remotePromise = new Promise((_) => (remoteResolve = _));

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        justification: 'ignored',
        reasons: ['WEB_RTC'],
      });

      await chrome.scripting.executeScript({
        target: {
          tabId: tab.id,
        },
        world: 'MAIN',
        args: [chrome.runtime.id],
        func: connectDataChannels,
      });
    }
  }

  chrome.runtime.onInstalled.addListener(closeOffscreen);

  chrome.action.onClicked.addListener(handleClick);

  addEventListener('install', (e) => {
    skipWaiting();
  });

  addEventListener('activate', (e) => {
    skipWaiting();
  });

  addEventListener('message', async (e) => {
    // const data = new TextEncoder().encode('transfer');
    if (e.data === 'start') {
      const request = await fetch(
        './manifest.json', // 291 MB
        // 'https://ia800301.us.archive.org/10/items/DELTAnine2013-12-11.WAV/Deltanine121113Pt3Wav.wav'
        {
          cache: 'no-store',
          credentials: 'omit',
        }
      );
      const { body } = request;
      e.source.postMessage(body, [body]);
      chrome.runtime.onConnectExternal.removeListener(handleSignaling);
      globalThis.signaling = {
        remote: null,
        local: null,
      };
      const dir = await navigator.storage.getDirectory();
      if (!(await dir.values().next()).done) {
        await dir.removeEntry('update_manifest.txt');
      }
    } else {
      // keep ServiceWorker active while streaming data
      e.source.postMessage(null);
    }
  });

  addEventListener('fetch', (e) => {
    e.respondWith(
      fetch(e.request.url, {
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
      })
    );
    // Alternatively
    // if (e.request.url.includes('data')) {
    //   e.respondWith(new Response(new TextEncoder().encode('transfer')));
    // }
  });
  // Offscreen
} else if (
  self instanceof Window &&
  location.href === chrome.runtime.getURL('offscreen.html')
) {
  (async function sendDataToWebPage() {
    const port = await new Promise((resolve) =>
      chrome.runtime.onConnect.addListener(resolve)
    );
    const remote = new RTCPeerConnection({
      sdpSemantics: 'unified-plan',
    });
    [
      'onsignalingstatechange',
      'oniceconnectionstatechange',
      'onicegatheringstatechange',
    ].forEach((e) => remote.addEventListener(e, console.log));

    remote.onicecandidate = async (e) => {
      // console.log('candidate', e.candidate);
      if (!e.candidate) {
        if (remote.localDescription.sdp.indexOf('a=end-of-candidates') === -1) {
          remote.localDescription.sdp += 'a=end-of-candidates\r\n';
          port.postMessage({
            remote: true,
            sdp: remote.localDescription.sdp,
          });
          const sdp = await new Promise((resolve) => {
            const handleMessage = (message) => {
              // console.log(message);
              port.onMessage.removeListener(handleMessage);
              resolve(message.sdp);
            };
            port.onMessage.addListener(handleMessage);
          });
          // console.log(sdp);
          remote.setRemoteDescription({
            type: 'answer',
            sdp,
          });
        }
      }
    };
    const channel = remote.createDataChannel('transfer', {
      negotiated: true,
      id: 0,
      binaryType: 'arraybuffer',
      protocol: 'raw',
    });
    channel.onopen = async (e) => {
      console.log(e, remote, channel);
      const sw = (await navigator.serviceWorker.ready).active;
      navigator.serviceWorker.onmessage = async (e) => {
        if (e.data instanceof ArrayBuffer) {
          // Transfer the ArrayBuffer
          const { byteLength } = e.data;
          channel.send(e.data.transfer(byteLength));
          console.log(e.data.byteLength);
          // 0
          // console.assert(data.byteLength === 0, {data});
          self.close();
        }
        if (e.data instanceof ReadableStream) {
          e.data.pipeTo(
            new WritableStream({
              write(value) {
                const { byteLength } = value.buffer;
                channel.send(value.buffer.transfer(byteLength));
                console.log(value.buffer.byteLength);
                // Keep ServiceWorker active while streaming data
                sw.postMessage(null);
              },
              close() {
                console.log('Stream closed.');
                channel.close();
                remote.close();
                self.close();
              },
            })
          );
        }
      };
      sw.postMessage('start');
      // Alternatively
      // const response = await fetch('./data');
      // const data = await response.arrayBuffer();
    };
    try {
      const offer = await remote.createOffer();
      if (offer.sdp.indexOf('a=end-of-candidates') === -1) {
        offer.sdp += 'a=end-of-candidates\r\n';
      }
      remote.setLocalDescription(offer);
    } catch (e) {
      console.warn(e);
    }
    // Ideally just use MessageEvent, postMessage()
    // for ServiceWorker <=> (offscreen) <=> Web page window communication
    // addEventListener('message', (e) => {
    //  console.log(e);
    // });
  })().catch(console.error);
}
