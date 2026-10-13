/* Bla — voice, video and screen share.
   Peer-to-peer WebRTC mesh: the Bla server only relays SDP/ICE, it never sees
   your audio or video. Everyone connects directly to everyone else. */
(function () {
  'use strict';
  const { el, clear, icon, $, toast, showMenu, formatBytes } = window.Bla;
  const S = window.BlaState;
  const state = S.state;
  const api = window.BlaApi;
  const R = window.BlaRender;

  const peers = new Map();          // userId -> { pc, sessionId, stream, audioEl, analyser, gain, state }
  const audioContextRef = { ctx: null };
  let localStream = null;
  let screenStream = null;
  let cameraStream = null;
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  let speakingTimer = null;
  let localMuted = false;
  let localDeafened = false;
  let currentChannelId = null;
  let deafenPlaybackGain = null;

  const hiddenAudio = el('div', { id: 'voice-audio', style: { display: 'none' } });

  function audioContext() {
    if (!audioContextRef.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioContextRef.ctx = new Ctx();
    }
    if (audioContextRef.ctx.state === 'suspended') audioContextRef.ctx.resume().catch(() => {});
    return audioContextRef.ctx;
  }

  function iceConfig() {
    return { iceServers, iceCandidatePoolSize: 4 };
  }

  async function loadIce() {
    try {
      const data = await api.ice();
      if (data.ice_servers?.length) iceServers = data.ice_servers;
    } catch { /* fall back to the default STUN list */ }
  }

  /* ── joining ───────────────────────────────────────────────────── */
  async function join(channelId) {
    if (currentChannelId && String(currentChannelId) === String(channelId)) {
      return openStage(channelId);
    }
    if (currentChannelId) await leave({ silent: true });

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      toast('Microphone blocked', 'Bla needs microphone permission to join voice. Check your browser settings.', 'error');
      return;
    }

    currentChannelId = channelId;
    const channel = state.channels.get(String(channelId));
    state.voiceChannel = {
      id: String(channelId),
      guildId: channel?.guild_id ? String(channel.guild_id) : null,
      selfMute: false, selfDeaf: false, video: false, screen: false, channel,
    };

    window.BlaGateway.joinVoice({
      channel_id: String(channelId),
      self_mute: false,
      self_deaf: false,
    });
    startSpeakingDetection();
    renderStage();
    R.renderUserPanel();
  }

  /** Called when the gateway answers with VOICE_READY. */
  function onReady(data) {
    startSpeakingDetection();
    if (data.peers?.length) {
      for (const peer of data.peers) ensurePeer(peer.user_id, peer.session_id, true);
    }
    renderStage();
    const channel = state.channels.get(String(data.channel_id));
    if (channel) toast('Connected to voice', channel.name, 'success');
  }

  function ensurePeer(userId, sessionId, createOffer = false) {
    const key = String(userId);
    let peer = peers.get(key);
    if (peer && peer.sessionId === sessionId) return peer;
    if (peer) closePeer(key);

    const pc = new RTCPeerConnection(iceConfig());
    peer = {
      pc,
      sessionId,
      stream: new MediaStream(),
      makingOffer: false,
      ignoreOffer: false,
      polite: String(state.sessionId || '') > String(sessionId),
      audioEl: null,
      audio: null,
      user: S.user(userId),
    };
    peers.set(key, peer);

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      window.BlaGateway.signal({
        channel_id: String(currentChannelId),
        session_id: sessionId,
        signal: { type: 'ice', candidate: candidate.toJSON() },
      });
    };

    pc.ontrack = ({ track, streams }) => {
      const [stream] = streams;
      peer.stream = stream;
      if (track.kind === 'audio') attachAudio(peer, stream);
      renderStage();
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        window.BlaGateway.signal({
          channel_id: String(currentChannelId),
          session_id: sessionId,
          signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      renderStage();
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(key);
    };

    if (createOffer) pc.onnegotiationneeded?.();
    return peer;
  }

  async function onSignal({ from_user_id: fromUserId, from_session_id: fromSession, signal }) {
    if (!currentChannelId || !signal) return;
    const peer = ensurePeer(fromUserId, fromSession, false);
    const pc = peer.pc;
    const description = signal.type === 'offer' || signal.type === 'answer'
      ? { type: signal.type, sdp: signal.sdp }
      : null;

    try {
      if (description) {
        const offerCollision = signal.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        if (offerCollision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        await pc.setRemoteDescription(description);
        if (signal.type === 'offer') {
          await pc.setLocalDescription();
          window.BlaGateway.signal({
            channel_id: String(currentChannelId),
            session_id: fromSession,
            signal: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      } else if (signal.type === 'ice' && signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) console.warn('ICE candidate failed', err);
        }
      } else if (signal.type === 'soundboard' && signal.sound) {
        playSound(signal.sound, false);
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  function attachAudio(peer, stream) {
    if (!peer.audioEl) {
      peer.audioEl = el('audio', { autoplay: true, playsinline: true });
      hiddenAudio.append(peer.audioEl);
      document.body.append(hiddenAudio);
    }
    peer.audioEl.srcObject = stream;
    peer.audioEl.play().catch(() => {});
  }

  function closePeer(userId) {
    const peer = peers.get(String(userId));
    if (!peer) return;
    try { peer.audioEl?.remove(); } catch { /* ignore */ }
    try { peer.pc.close(); } catch { /* ignore */ }
    peers.delete(String(userId));
  }

  async function leave({ silent = false } = {}) {
    if (!currentChannelId) return;
    window.BlaGateway.leaveVoice();
    for (const key of [...peers.keys()]) closePeer(key);
    localStream?.getTracks().forEach((t) => t.stop());
    screenStream?.getTracks().forEach((t) => t.stop());
    cameraStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    screenStream = null;
    cameraStream = null;
    currentChannelId = null;
    state.voiceChannel = null;
    stopSpeakingDetection();
    closeStage();
    R.renderUserPanel();
    R.renderSidebar();
    if (!silent) toast('Left voice');
  }

  /* ── speaking detection ────────────────────────────────────────── */
  function startSpeakingDetection() {
    if (speakingTimer) return;
    speakingTimer = setInterval(() => {
      if (!localStream) return;
      const analyser = localStream.__analyser || (localStream.__analyser = createAnalyser(localStream));
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) sum += value;
      const level = sum / data.length;
      const speaking = level > 12 && !localMuted;
      if (speaking !== state.localSpeaking) {
        state.localSpeaking = speaking;
        window.BlaGateway.speaking(speaking);
        renderStage();
      }
    }, 300);
  }

  function createAnalyser(stream) {
    try {
      const ctx = audioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  function stopSpeakingDetection() {
    clearInterval(speakingTimer);
    speakingTimer = null;
    state.localSpeaking = false;
  }

  function onSpeaking({ user_id: userId, speaking }) {
    if (!state.speakingUsers) state.speakingUsers = new Set();
    if (speaking) state.speakingUsers.add(String(userId));
    else state.speakingUsers.delete(String(userId));
    renderStage();
    R.renderSidebar();
  }

  /* ── controls ──────────────────────────────────────────────────── */
  function toggleMute(force = null) {
    if (!state.voiceChannel) {
      toast('Not in a voice channel', 'Join one first.', 'error');
      return;
    }
    localMuted = force === null ? !localMuted : !!force;
    state.voiceChannel.selfMute = localMuted;
    localStream?.getAudioTracks().forEach((track) => { track.enabled = !localMuted; });
    window.BlaGateway.updateVoice({ self_mute: localMuted });
    R.renderUserPanel();
    renderStage();
  }

  function toggleDeafen(force = null) {
    if (!state.voiceChannel) return;
    localDeafened = force === null ? !localDeafened : !!force;
    state.voiceChannel.selfDeaf = localDeafened;
    if (localDeafened) {
      localMuted = true;
      localStream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    }
    for (const peer of peers.values()) {
      if (peer.audioEl) peer.audioEl.muted = localDeafened;
    }
    window.BlaGateway.updateVoice({ self_deaf: localDeafened, self_mute: localMuted });
    state.voiceChannel.selfMute = localMuted;
    R.renderUserPanel();
    renderStage();
  }

  async function toggleCamera() {
    if (!state.voiceChannel) return;
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      for (const peer of peers.values()) {
        const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'video' && s.track === cameraStream.getVideoTracks()[0]);
        if (sender) sender.replaceTrack(null).catch(() => {});
      }
      cameraStream = null;
      state.voiceChannel.video = false;
      window.BlaGateway.updateVoice({ self_video: false });
      renderStage();
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      const track = cameraStream.getVideoTracks()[0];
      let added = false;
      for (const peer of peers.values()) {
        const videoSender = peer.pc.getSenders().find((s) => s.track?.kind === 'video' || s.track === null);
        if (videoSender && videoSender.track === null) {
          await videoSender.replaceTrack(track);
        } else if (!added) {
          peer.pc.addTrack(track, cameraStream);
          added = true;
        }
      }
      state.voiceChannel.video = true;
      window.BlaGateway.updateVoice({ self_video: true });
      renderStage();
    } catch {
      toast('Camera blocked', 'Could not start your camera.', 'error');
    }
  }

  async function toggleScreen() {
    if (!state.voiceChannel) return;
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
      state.voiceChannel.screen = false;
      window.BlaGateway.updateVoice({ self_stream: false });
      renderStage();
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      const track = screenStream.getVideoTracks()[0];
      track.addEventListener('ended', () => { screenStream = null; state.voiceChannel.screen = false; renderStage(); });
      let added = false;
      for (const peer of peers.values()) {
        const videoSender = peer.pc.getSenders().find((s) => s.track?.kind === 'video' && s.track !== cameraStream?.getVideoTracks()[0]);
        if (videoSender) await videoSender.replaceTrack(track);
        else if (!added) { peer.pc.addTrack(track, screenStream); added = true; }
      }
      state.voiceChannel.screen = true;
      window.BlaGateway.updateVoice({ self_stream: true });
      renderStage();
      toast('Screen sharing', 'Everyone in the channel can see your screen.');
    } catch {
      toast('Screen share cancelled', '', 'error');
    }
  }

  /* ── soundboard ────────────────────────────────────────────────── */
  function playSoundboard() {
    const guild = S.currentGuild();
    const sounds = guild?.soundboard || [];
    if (!sounds.length) return toast('No sounds yet', 'Add them in Server Settings → Emoji & Stickers.', 'error');
    showMenu({ clientX: window.innerWidth / 2, clientY: window.innerHeight - 120, preventDefault() {}, stopPropagation() {} },
      sounds.map((sound) => ({
        label: sound.name,
        action: () => {
          playSound(sound, true);
          for (const peer of peers.values()) {
            window.BlaGateway.signal({
              channel_id: String(currentChannelId),
              session_id: peer.sessionId,
              signal: { type: 'soundboard', sound },
            });
          }
        },
      })));
  }

  function playSound(sound, announce = false) {
    try {
      const audio = new Audio(sound.url);
      audio.volume = Math.max(0, Math.min(1, sound.volume ?? 1));
      audio.play().catch(() => {});
      if (announce) toast('Soundboard', sound.name);
    } catch { /* ignore */ }
  }

  /* ── stage UI ──────────────────────────────────────────────────── */
  function renderStage() {
    const stage = $('#voice-stage');
    if (!state.voiceChannel) { hideStage(); return; }
    stage.hidden = false;
    clear(stage);
    const channel = state.channels.get(String(state.voiceChannel.id)) || state.voiceChannel.channel;
    const guild = state.voiceChannel.guildId ? state.guilds.get(String(state.voiceChannel.guildId)) : null;

    const participants = new Map();
    participants.set(String(state.me.id), { user: state.me, local: true, state: state.voiceChannel });
    for (const voiceState of state.voiceStates.values()) {
      if (String(voiceState.channel_id) !== String(state.voiceChannel.id)) continue;
      if (String(voiceState.user_id) === String(state.me.id)) continue;
      participants.set(String(voiceState.user_id), { user: S.user(voiceState.user_id), voiceState, peer: peers.get(String(voiceState.user_id)) });
    }

    stage.append(el('div', { class: 'voice-stage-header' }, [
      icon('volume', 'icon'),
      el('div', { class: 'title' }, [
        el('div', {}, channel?.name || 'Voice'),
        el('div', { class: 'faint', style: { fontSize: '13px' } },
          `${participants.size} connected · peer-to-peer · ${guild ? guild.name : 'direct message'}`),
      ]),
      el('span', { class: 'badge boost' }, '384 kbps'),
      el('button', { class: 'icon-btn', 'data-tip': 'Minimise', onclick: () => hideStage(true) }, [icon('chevronDown')]),
    ]));

    const grid = el('div', { class: `voice-grid ${participants.size === 1 ? 'solo' : ''}` });
    for (const [userId, entry] of participants) {
      grid.append(tile(entry, userId));
    }
    stage.append(grid);

    const controls = el('div', { class: 'voice-controls' }, [
      el('button', {
        class: `btn ${localMuted ? '' : 'on'}`, 'data-tip': localMuted ? 'Unmute' : 'Mute',
        onclick: () => toggleMute(),
      }, [icon(localMuted ? 'micOff' : 'mic')]),
      el('button', {
        class: `btn ${localDeafened ? '' : 'on'}`, 'data-tip': localDeafened ? 'Undeafen' : 'Deafen',
        onclick: () => toggleDeafen(),
      }, [icon('headphones')]),
      el('button', {
        class: `btn ${state.voiceChannel.video ? 'on' : ''}`, 'data-tip': 'Camera',
        onclick: () => toggleCamera(),
      }, [icon('video')]),
      el('button', {
        class: `btn ${state.voiceChannel.screen ? 'on' : ''}`, 'data-tip': 'Share screen',
        onclick: () => toggleScreen(),
      }, [icon('screen')]),
      el('button', { class: 'btn', 'data-tip': 'Soundboard', onclick: () => playSoundboard() }, [icon('music')]),
      el('button', { class: 'btn hangup', 'data-tip': 'Disconnect', onclick: () => leave() }, [icon('phoneOff')]),
    ]);
    stage.append(controls);
  }

  function tile(entry, userId) {
    const user = entry.user;
    const speaking = entry.local ? state.localSpeaking : state.speakingUsers?.has(String(userId));
    const videoState = entry.local
      ? entry.state
      : (entry.voiceState || {});
    const node = el('div', {
      class: `voice-tile ${speaking ? 'speaking' : ''} ${videoState?.self_stream ? 'streaming' : ''}`,
      oncontextmenu: (event) => userTileMenu(event, userId, entry),
    });

    const videoStream = entry.local
      ? (screenStream || cameraStream)
      : entry.peer?.stream;
    const hasVideo = entry.local ? !!(screenStream || cameraStream) : !!(entry.peer?.stream?.getVideoTracks().length);

    if (hasVideo && videoStream) {
      const video = el('video', {
        autoplay: true, playsinline: true, muted: entry.local,
      });
      video.srcObject = videoStream;
      video.play().catch(() => {});
      node.append(video);
    } else {
      node.append(el('div', { class: 'tile-avatar' }, [
        R.avatar(user, { size: 84, status: R.presenceOf(userId) }),
        el('div', { class: 'muted' }, S.displayName(user)),
      ]));
    }

    node.append(el('div', { class: 'tile-name' }, [
      speaking ? el('span', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--online)' } }) : null,
      S.displayName(user),
      entry.local ? el('span', { class: 'faint' }, '(you)') : null,
    ]));

    node.append(el('div', { class: 'tile-icons' }, [
      videoState?.self_mute || videoState?.server_mute ? icon('micOff') : null,
      videoState?.self_deaf || videoState?.server_deaf ? icon('headphones') : null,
      videoState?.self_video ? icon('video') : null,
      videoState?.self_stream ? icon('screen') : null,
    ]));
    return node;
  }

  function userTileMenu(event, userId, entry) {
    if (String(userId) === String(state.me?.id)) {
      return showMenu(event, [
        { label: 'Mute myself', icon: 'micOff', action: () => toggleMute() },
        { label: 'Disconnect', icon: 'phoneOff', danger: true, action: () => leave() },
      ]);
    }
    const guildId = state.voiceChannel?.guildId;
    const items = [
      { label: 'View profile', icon: 'users', action: () => window.BlaModals.userProfile(userId, guildId) },
    ];
    if (state.settings.voiceVolume === undefined) state.settings.voiceVolume = {};
    const volume = state.settings.voiceVolume?.[userId] ?? 100;
    items.push({
      label: volume === 0 ? 'Un-mute for me' : `Mute for me`,
      icon: 'headphones',
      action: () => {
        state.settings.voiceVolume = state.settings.voiceVolume || {};
        state.settings.voiceVolume[userId] = volume === 0 ? 100 : 0;
        S.saveSettings();
        applyVolumes();
      },
    });
    if (guildId && S.can(S.PERM.MUTE_MEMBERS, guildId)) {
      items.push({ type: 'separator' }, {
        label: entry.voiceState?.server_mute ? 'Unmute in server' : 'Mute in server',
        icon: 'micOff',
        action: async () => { await api.voiceModerate(userId, { guild_id: guildId, server_mute: !entry.voiceState?.server_mute }); },
      }, {
        label: entry.voiceState?.server_deaf ? 'Undeafen' : 'Deafen in server',
        icon: 'headphones',
        action: async () => { await api.voiceModerate(userId, { guild_id: guildId, server_deaf: !entry.voiceState?.server_deaf }); },
      }, {
        label: 'Disconnect them',
        icon: 'kick',
        danger: true,
        action: async () => { await api.voiceModerate(userId, { guild_id: guildId, channel_id: null }); },
      });
    }
    showMenu(event, items);
  }

  function applyVolumes() {
    for (const [userId, peer] of peers) {
      const volume = state.settings.voiceVolume?.[userId] ?? 100;
      if (peer.audioEl) peer.audioEl.volume = Math.max(0, Math.min(1, volume / 100));
    }
  }

  function openStage(channelId) {
    renderStage();
  }

  function hideStage(minimised = false) {
    const stage = $('#voice-stage');
    if (minimised) {
      stage.hidden = true;
      stage.dataset.minimised = '1';
      return;
    }
    stage.hidden = true;
  }

  function closeStage() {
    const stage = $('#voice-stage');
    stage.hidden = true;
    clear(stage);
  }

  /** Clean up when the gateway says we were disconnected server-side. */
  function onVoiceState(data) {
    if (String(data.user_id) !== String(state.me?.id)) return;
    if (!data.channel_id && currentChannelId) {
      toast('Disconnected from voice', 'A moderator moved you out of the channel.', 'error');
      leave({ silent: true });
    }
  }

  window.BlaVoice = {
    loadIce, join, leave, onReady, onSignal, onSpeaking, onVoiceState,
    toggleMute, toggleDeafen, toggleCamera, toggleScreen, playSoundboard, playSound,
    renderStage, isConnected: () => !!currentChannelId,
  };
}());
