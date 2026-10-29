var NodeHelper = require('node_helper');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Hue bridges serve a self-signed certificate, so verification is disabled for bridge requests only.
const hueAgent = new https.Agent({
    rejectUnauthorized: false
});

const BRIDGE_CACHE_FILE = path.join(__dirname, 'bridge-ip.json');
const DISCOVERY_URL = 'https://discovery.meethue.com';
// The discovery service rate-limits callers, so it is asked at most this often.
const DISCOVERY_MIN_INTERVAL = 5 * 60 * 1000;
const NETWORK_ERROR_CODES = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ETIMEOUT'];
const STREAM_RETRY_MIN = 5000;
const STREAM_RETRY_MAX = 60000;
// Several events usually arrive together (one per light in a room), so refresh once they settle.
const STREAM_REFRESH_DELAY = 300;
// Scenes change rarely; scene events from the stream refresh them sooner.
const SCENE_REFRESH_INTERVAL = 5 * 60 * 1000;

const COLOR_TEMPERATURES = {
    cool: 153,
    medium: 260,
    warm: 360
};

module.exports = NodeHelper.create({

    start: function() {
        console.log('Starting node_helper for module [' + this.name + ']');

        // Populated from the config sent with every MMM_HUE_LIGHTS_GET.
        this.configuredBridgeIp = null;
        this.bridgeIp = this.readCachedBridgeIp();
        this.user = null;
        this.cameraLights = null;
        this.lastDiscovery = 0;
        this.discovering = null;

        this.stream = null;
        this.streamRetryDelay = STREAM_RETRY_MIN;
        this.streamRetryTimer = null;
        this.streamRefreshTimer = null;
        this.sceneRefreshTimer = null;
        this.lastSceneRefresh = 0;
    },

    setHueConfig: function(payload) {
        if (payload.bridgeIp && payload.bridgeIp !== this.configuredBridgeIp) {
            this.configuredBridgeIp = payload.bridgeIp;
            if (!this.bridgeIp) {
                this.bridgeIp = payload.bridgeIp;
            }
        }
        this.user = payload.user;
        this.cameraLights = payload.cameraLights;
    },

    readCachedBridgeIp: function() {
        try {
            return JSON.parse(fs.readFileSync(BRIDGE_CACHE_FILE, 'utf8')).bridgeIp || null;
        } catch (error) {
            return null;
        }
    },

    useBridgeIp: function(bridgeIp) {
        if (bridgeIp === this.bridgeIp) {
            return;
        }
        console.log('Using Hue bridge at ' + bridgeIp);
        this.bridgeIp = bridgeIp;
        try {
            fs.writeFileSync(BRIDGE_CACHE_FILE, JSON.stringify({ bridgeIp: bridgeIp }) + '\n');
        } catch (error) {
            console.error('Could not save the Hue bridge address:', error.message);
        }
        this.restartEventStream();
    },

    isNetworkError: function(error) {
        return NETWORK_ERROR_CODES.includes(error.code) || error.message === 'Request timed out';
    },

    /*
     * Find a bridge that accepts our user: the configured address, then the bridges the Hue discovery service
     * reports for this network. Resolves with the address now in use, or rejects if none answered.
     */
    findBridge: function() {
        var self = this;
        if (this.discovering) {
            return this.discovering;
        }
        if (Date.now() - this.lastDiscovery < DISCOVERY_MIN_INTERVAL) {
            return Promise.reject(new Error('Hue bridge not reachable at ' + this.bridgeIp));
        }
        this.lastDiscovery = Date.now();

        this.discovering = this.discoverBridgeIps()
            .catch(function(error) {
                console.error('Hue bridge discovery failed:', error.message);
                return [];
            })
            .then(async function(discoveredIps) {
                var candidates = [self.configuredBridgeIp].concat(discoveredIps)
                    .filter(function(ip, index, all) { return ip && ip !== self.bridgeIp && all.indexOf(ip) === index; });
                for (const candidate of candidates) {
                    try {
                        await self.hueRequestAt(candidate, 'GET', 'config');
                        self.useBridgeIp(candidate);
                        return candidate;
                    } catch (error) {
                        console.log('No usable Hue bridge at ' + candidate + ': ' + error.message);
                    }
                }
                throw new Error('No Hue bridge found that accepts the configured user');
            })
            .finally(function() {
                self.discovering = null;
            });
        return this.discovering;
    },

    discoverBridgeIps: function() {
        return new Promise(function(resolve, reject) {
            var request = https.get(DISCOVERY_URL, { timeout: 10000 }, function(response) {
                var chunks = [];
                response.on('data', function(chunk) { chunks.push(chunk); });
                response.on('end', function() {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString()).map(function(bridge) { return bridge.internalipaddress; }));
                    } catch (error) {
                        reject(new Error('Unexpected discovery response (HTTP ' + response.statusCode + ')'));
                    }
                });
            });
            request.on('timeout', function() {
                request.destroy(new Error('Request timed out'));
            });
            request.on('error', reject);
        });
    },


    /*
     * Send a request to the bridge and resolve with the parsed JSON body. The bridge answers HTTP 200 even when
     * a command fails, listing failures as {error: ...} entries, so those are rejected here too.
     */
    hueRequest: function(method, apiPath, body) {
        var self = this;
        var attempt = function() {
            if (!self.bridgeIp) {
                return Promise.reject(Object.assign(new Error('No bridge address yet'), { code: 'ENETUNREACH' }));
            }
            return self.hueRequestAt(self.bridgeIp, method, apiPath, body);
        };
        // If the bridge has moved (a new DHCP address), find it again and retry once.
        return attempt().catch(function(error) {
            if (!self.isNetworkError(error)) {
                throw error;
            }
            return self.findBridge().then(attempt, function() { throw error; });
        });
    },

    /*
     * `apiPath` is relative to the v1 API (`lights`), or an absolute v2 path (`/clip/v2/resource/scene`).
     */
    hueRequestAt: function(bridgeIp, method, apiPath, body) {
        var isV2 = apiPath.startsWith('/');
        var url = isV2 ? `https://${bridgeIp}${apiPath}` : `https://${bridgeIp}/api/${this.user}/${apiPath}`;
        var headers = { 'Content-Type': 'application/json' };
        if (isV2) {
            headers['hue-application-key'] = this.user;
        }
        return new Promise(function(resolve, reject) {
            var request = https.request(url, {
                method: method,
                agent: hueAgent,
                timeout: 10000,
                headers: headers
            }, function(response) {
                var chunks = [];
                response.on('data', function(chunk) { chunks.push(chunk); });
                response.on('end', function() {
                    var text = Buffer.concat(chunks).toString();
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error('HTTP ' + response.statusCode + ': ' + text));
                        return;
                    }
                    var parsed;
                    try {
                        parsed = JSON.parse(text);
                    } catch (parseError) {
                        reject(new Error('Invalid JSON response'));
                        return;
                    }
                    var errors = Array.isArray(parsed)
                        ? parsed.filter(function(entry) { return entry.error; }).map(function(entry) { return entry.error; })
                        : (parsed.errors || []);
                    if (errors.length > 0) {
                        reject(new Error(errors.map(function(entry) { return entry.description; }).join('; ')));
                        return;
                    }
                    resolve(parsed);
                });
            });
            request.on('timeout', function() {
                request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEOUT' }));
            });
            request.on('error', reject);
            if (body) {
                request.write(JSON.stringify(body));
            }
            request.end();
        });
    },

    /*
     * Only lights and groups are needed; fetching the whole bridge (/api/<user>) also downloads every sensor,
     * rule and schedule on each poll.
     */
    getHueData: function() {
        var self = this;
        Promise.all([
            this.hueRequest('GET', 'lights'),
            this.hueRequest('GET', 'groups')
        ]).then(function([lights, groups]) {
            self.sendSocketNotification('MMM_HUE_LIGHTS_DATA', { lights: lights, groups: groups });
        }).catch(function(error) {
            console.error('Hue API error reading lights:', error.message);
            self.sendSocketNotification('MMM_HUE_LIGHTS_DATA_ERROR', 'Hue API Error: ' + error.message);
        });
    },

    /*
     * Hold the bridge's v2 event stream open so changes made anywhere (the Hue app, a switch, a schedule) show
     * on the mirror within a moment. Events only trigger a normal read, so the display logic stays in one place.
     */
    startEventStream: function() {
        var self = this;
        if (this.stream || this.streamRetryTimer || !this.bridgeIp || !this.user) {
            return;
        }

        var buffered = '';
        var request = https.get(`https://${this.bridgeIp}/eventstream/clip/v2`, {
            agent: hueAgent,
            headers: { 'hue-application-key': this.user, 'Accept': 'text/event-stream' }
        }, function(response) {
            if (response.statusCode !== 200) {
                response.resume();
                request.destroy(new Error('HTTP ' + response.statusCode));
                return;
            }
            console.log('Hue event stream connected');
            self.streamRetryDelay = STREAM_RETRY_MIN;
            response.setEncoding('utf8');
            response.on('data', function(chunk) {
                buffered += chunk;
                var messages = buffered.split('\n\n');
                buffered = messages.pop();
                if (messages.some(function(message) { return self.isEventOfType(message, ['light', 'grouped_light']); })) {
                    self.scheduleStreamRefresh();
                }
                if (messages.some(function(message) { return self.isEventOfType(message, ['scene']); })) {
                    self.scheduleSceneRefresh();
                }
            });
            response.on('end', function() {
                request.destroy(new Error('Stream ended'));
            });
        });
        request.on('error', function(error) {
            if (self.stream === request) {
                console.log('Hue event stream closed: ' + error.message);
            }
        });
        request.on('close', function() {
            if (self.stream !== request) {
                return;
            }
            self.stream = null;
            var delay = self.streamRetryDelay;
            self.streamRetryDelay = Math.min(delay * 2, STREAM_RETRY_MAX);
            self.streamRetryTimer = setTimeout(function() {
                self.streamRetryTimer = null;
                self.startEventStream();
            }, delay);
        });
        this.stream = request;
    },

    restartEventStream: function() {
        clearTimeout(this.streamRetryTimer);
        this.streamRetryTimer = null;
        this.streamRetryDelay = STREAM_RETRY_MIN;
        var oldStream = this.stream;
        this.stream = null;
        if (oldStream) {
            oldStream.destroy();
        }
        this.startEventStream();
    },

    isEventOfType: function(message, types) {
        var dataLines = message.split('\n').filter(function(line) { return line.startsWith('data:'); });
        if (dataLines.length === 0) {
            return false;
        }
        try {
            var events = JSON.parse(dataLines.map(function(line) { return line.slice(5); }).join('\n'));
            return events.some(function(event) {
                return (event.data || []).some(function(resource) {
                    return types.includes(resource.type);
                });
            });
        } catch (error) {
            return false;
        }
    },

    scheduleStreamRefresh: function() {
        var self = this;
        clearTimeout(this.streamRefreshTimer);
        this.streamRefreshTimer = setTimeout(function() {
            self.getHueData();
        }, STREAM_REFRESH_DELAY);
    },

    /*
     * Send the scenes saved for each room and zone, keyed by v1 group number. The v2 API is used because it
     * leaves out the bridge's internal scenes and includes each scene's palette and whether it is active.
     */
    getScenes: function() {
        var self = this;
        this.lastSceneRefresh = Date.now();
        Promise.all([
            this.hueRequest('GET', '/clip/v2/resource/scene'),
            this.hueRequest('GET', '/clip/v2/resource/room'),
            this.hueRequest('GET', '/clip/v2/resource/zone')
        ]).then(function([scenes, rooms, zones]) {
            var groupNumById = {};
            rooms.data.concat(zones.data).forEach(function(group) {
                var match = /^\/groups\/(\d+)$/.exec(group.id_v1 || '');
                if (match) {
                    groupNumById[group.id] = match[1];
                }
            });

            var scenesByGroup = {};
            scenes.data.forEach(function(scene) {
                var groupNum = groupNumById[scene.group.rid];
                if (!groupNum) {
                    return;
                }
                (scenesByGroup[groupNum] = scenesByGroup[groupNum] || []).push({
                    id: scene.id,
                    name: scene.metadata.name,
                    active: Boolean(scene.status && scene.status.active && scene.status.active !== 'inactive'),
                    colors: self.sceneColors(scene)
                });
            });
            Object.values(scenesByGroup).forEach(function(list) {
                list.sort(function(a, b) { return a.name.localeCompare(b.name); });
            });
            self.sendSocketNotification('HUE_SCENES', scenesByGroup);
        }).catch(function(error) {
            console.error('Hue API error reading scenes:', error.message);
        });
    },

    /*
     * Colours to draw for a scene: its palette if it has one, otherwise the colours its lights are set to.
     * Each is {xy: [x, y]} or {mirek: n}.
     */
    sceneColors: function(scene) {
        var toColor = function(entry) {
            if (entry.color && entry.color.xy) {
                return { xy: [entry.color.xy.x, entry.color.xy.y] };
            }
            if (entry.color_temperature && entry.color_temperature.mirek) {
                return { mirek: entry.color_temperature.mirek };
            }
            return null;
        };
        var palette = scene.palette || {};
        var colors = (palette.color || []).concat(palette.color_temperature || []).map(toColor);
        if (colors.filter(Boolean).length === 0) {
            colors = (scene.actions || []).map(function(entry) { return toColor(entry.action || {}); });
        }
        var seen = {};
        return colors.filter(function(color) {
            var key = JSON.stringify(color);
            if (!color || seen[key]) {
                return false;
            }
            seen[key] = true;
            return true;
        }).slice(0, 5);
    },

    recallScene: function(sceneId) {
        var self = this;
        this.hueRequest('PUT', '/clip/v2/resource/scene/' + sceneId, { recall: { action: 'active' } })
            .catch(function(error) {
                console.error('Hue API error recalling scene ' + sceneId + ':', error.message);
                self.sendSocketNotification('SCENE_FAILED', { id: sceneId, error: error.message });
                self.getScenes();
            });
    },

    scheduleSceneRefresh: function() {
        var self = this;
        clearTimeout(this.sceneRefreshTimer);
        this.sceneRefreshTimer = setTimeout(function() {
            self.getScenes();
        }, STREAM_REFRESH_DELAY);
    },

    setGroupPower: function(groupNum, on) {
        var self = this;
        var notification = on ? 'LIGHTS_TURNED_ON' : 'LIGHTS_TURNED_OFF';
        this.hueRequest('PUT', `groups/${groupNum}/action`, { on: on })
            .then(function() {
                self.sendSocketNotification(notification, groupNum);
            })
            .catch(function(error) {
                console.error('Hue API error turning group ' + groupNum + (on ? ' on:' : ' off:'), error.message);
                self.sendSocketNotification('LIGHTS_TOGGLE_FAILED', { num: groupNum, error: error.message });
            });
    },

    setGroupBrightness: function(groupNum, bri) {
        var self = this;
        this.hueRequest('PUT', `groups/${groupNum}/action`, { bri: bri })
            .catch(function(error) {
                console.error('Hue API error setting brightness of group ' + groupNum + ':', error.message);
                self.sendSocketNotification('BRIGHTNESS_FAILED', { num: groupNum, error: error.message });
            });
    },

    putLightState: function(lightId, body, description) {
        this.hueRequest('PUT', `lights/${lightId}/state`, body)
            .then(function(responseBody) {
                console.log('Hue updated ' + description + ':', responseBody);
            })
            .catch(function(error) {
                console.error('Hue API error for ' + description + ':', error.message);
            });
    },

    /*
     * Set the camera lights to white at full brightness. `type` is a colour temperature in mireds or one of
     * the COLOR_TEMPERATURES names.
     */
    setCameraWhite: function(type) {
        if (!this.user || !this.cameraLights) {
            console.error('Hue configuration has not been initialized.');
            return;
        }

        var ct = (typeof type === 'number') ? Math.round(type) : (COLOR_TEMPERATURES[type] || COLOR_TEMPERATURES.cool);
        var body = { on: true, ct: ct, bri: 254 };

        for (const [role, lightId] of Object.entries(this.cameraLights)) {
            this.putLightState(lightId, body, role + ' camera light');
        }
    },

    /*
     * Restore the camera lights to the states saved before the camera used them.
     */
    restoreCameraLights: function(savedStates) {
        console.log('Setting camera lights back to stored state:', savedStates);

        if (!this.user || !this.cameraLights) {
            console.error('Hue configuration has not been initialized.');
            return;
        }

        for (const [role, lightId] of Object.entries(this.cameraLights)) {
            var saved = savedStates && savedStates[role];
            if (!saved) {
                console.error('No saved state for the ' + role + ' camera light, leaving it as it is.');
                continue;
            }
            this.putLightState(lightId, {
                on: saved.on !== false,
                bri: saved.bri,
                hue: saved.hue,
                sat: saved.sat,
                xy: saved.xy,
                ct: saved.ct
            }, role + ' camera light');
        }
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === 'MMM_HUE_LIGHTS_GET') {
            this.setHueConfig(payload);
            this.getHueData();
            this.startEventStream();
            if (Date.now() - this.lastSceneRefresh > SCENE_REFRESH_INTERVAL) {
                this.getScenes();
            }
        } else if (notification === 'TURN_OFF_LIGHTS') {
            this.setGroupPower(payload, false);
        } else if (notification === 'TURN_ON_LIGHTS') {
            this.setGroupPower(payload, true);
        } else if (notification === 'GET_SCENES') {
            this.getScenes();
        } else if (notification === 'RECALL_SCENE') {
            this.recallScene(payload);
        } else if (notification === 'SET_GROUP_BRIGHTNESS') {
            this.setGroupBrightness(payload.num, payload.bri);
        } else if (notification === 'SWITCH_CAMERA_WHITE') {
            this.setCameraWhite(payload);
        } else if (notification === 'SWITCH_CAMERA_COLOR') {
            this.restoreCameraLights(payload);
        }
    }
});
