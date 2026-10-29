/* global Module */

/* Magic Mirror
 * Module: MMM-PhillipsHueController
 *
 * By Michael Schmidt
 * https://github.com/michael5r
 *
 * MIT Licensed.
 */

Module.register('MMM-PhillipsHueController', {

    defaults: {
        bridgeIp: '',
        user: '',
        displayType: 'grid',
        displayMode: 'groups',
        displayFilter: ['all'],
        hideFilter: [],
        orderByName: false,
        updateInterval: 15000,
        // Lights the photobooth sets to white while capturing. Keys are free-form role names.
        cameraLights: { left: 21, right: 22, bulb: 47 },
        // How long (ms) a tapped room keeps its new state on screen while waiting for the bridge to report it.
        toggleConfirmTimeout: 5000,
        // Minimum time (ms) between brightness commands while dragging a room's brightness bar.
        brightnessThrottle: 250,
        version: '1.4.0'
    },

    getScripts: function() {
        return [
            'handlebars.runtime.min-v4.0.12.js',
            'mmm-hue-lights-templates.js'
        ];
    },

    getStyles: function() {
        return [
            'MMM-PhillipsHueController.css'
        ];
    },

    start: function() {

        Log.info('Starting module: ' + this.name + ', version ' + this.config.version);

        this.errMsg = '';

        this.loaded = false;
        this.getData();
        this.scheduleUpdate();

        this.sleepTimer = null;
        this.sleeping = false;
        this.cameraDeployed = false;

        this.lights = {};
        this.groups = {};
        // Light states from before the camera used them, keyed like config.cameraLights.
        this.cameraLightStates = null;
        this.previewState = null;
        this.cameraStateFrozenUntil = 0;

        this.groupNumLookup = {};
        // Rooms tapped but not yet reported back by the bridge: groupNum -> {on, until}.
        this.pendingToggles = {};
        // Brightness set from the mirror but not yet reported back by the bridge: groupNum -> {bri, until}.
        this.pendingBrightness = {};
        this.brightnessDragging = false;
        this.renderAfterDrag = false;
        this.suppressNextClick = false;
        this.brightnessSendTimer = null;
        this.lastBrightnessSent = 0;

        this.hbDataArr = [];

    },

    getDom: function() {
        var outer_wrapper = document.createElement('div');
        // show error message
        if (this.errMsg !== '') {
            outer_wrapper.innerHTML = this.errMsg;
            outer_wrapper.className = ' normal regular small ';
            return outer_wrapper;
        } else if (!this.loaded) {
            outer_wrapper.innerHTML = 'Loading ...';
            outer_wrapper.className = 'bright light small';
            return outer_wrapper;
        } else {
            outer_wrapper.className = 'outer-wrapper';
        }

        this.renderGrid();
        var self = this;
        this.hbDataArr.forEach(function(hbData) {
            var room_wrapper = document.createElement('div');
            room_wrapper.className = self.classNames(
                'hue-wrapper',
                'grid',
                'groups'
            );

            var hbTemplate = Handlebars.templates['hue_grid.hbs'];
            var hbHtml     = hbTemplate(hbData);
            room_wrapper.innerHTML = hbHtml;

            room_wrapper.addEventListener("click", function () {
                if (self.suppressNextClick) {
                    self.suppressNextClick = false;
                    return;
                }
                self.roomClicked(hbData.rows[0].name);
            });
            self.attachBrightnessDrag(room_wrapper, hbData.rows[0].name);

            outer_wrapper.appendChild(room_wrapper);
        })

        return outer_wrapper;
    },

    roomClicked: function(roomName) {
        let groupNum = this.groupNumLookup[roomName];
        var room = this.groups[groupNum];
        if (!room) {
            return;
        }
        var turnOn = !room.state.any_on;
        // Show the new state straight away; the bridge takes a moment to confirm it.
        this.pendingToggles[groupNum] = { on: turnOn, until: Date.now() + Number(this.config.toggleConfirmTimeout) };
        this.applyGroupPower(this.groups, this.lights, groupNum, turnOn);
        this.updateDom(0);
        this.sendSocketNotification(turnOn ? 'TURN_ON_LIGHTS' : 'TURN_OFF_LIGHTS', groupNum);
    },

    /*
     * Make a room's brightness bar draggable. Electron treats a finger drag as a scroll unless the touch events
     * are handled directly, and the bar is thin, so touches just above or below it count too.
     */
    attachBrightnessDrag: function(wrapper, roomName) {
        var self = this;
        var bar = wrapper.querySelector('.bot');
        var fill = bar && bar.querySelector('.toggle');
        if (!fill) {
            return;
        }
        var HIT_MARGIN = 15;
        var dragging = false;

        var onBar = function(clientY) {
            var rect = bar.getBoundingClientRect();
            return clientY >= rect.top - HIT_MARGIN && clientY <= rect.bottom + HIT_MARGIN;
        };
        var update = function(clientX, isFinal) {
            var rect = bar.getBoundingClientRect();
            // The bar's width puts the knob's right edge at (percent - 1)% + 20px; solve so the knob follows the finger.
            var percent = Math.round(((clientX - rect.left - 10) / rect.width) * 100 + 1);
            percent = Math.min(100, Math.max(1, percent));
            fill.style.width = self.brightnessBarWidth(percent);
            self.setBrightness(self.groupNumLookup[roomName], Math.max(1, Math.round(percent * 254 / 100)), isFinal);
        };
        var begin = function() {
            dragging = true;
            self.brightnessDragging = true;
        };
        var finish = function() {
            dragging = false;
            self.brightnessDragging = false;
            if (self.renderAfterDrag) {
                self.renderAfterDrag = false;
                self.applyPendingBrightness(self.groups, self.lights);
                self.updateDom();
            }
        };

        wrapper.addEventListener('touchstart', function(event) {
            if (!onBar(event.touches[0].clientY)) {
                return;
            }
            // Also stops the tap from becoming a click, which would toggle the room.
            event.preventDefault();
            begin();
            update(event.touches[0].clientX, false);
        }, { passive: false });
        wrapper.addEventListener('touchmove', function(event) {
            if (dragging) {
                event.preventDefault();
                update(event.touches[0].clientX, false);
            }
        }, { passive: false });
        wrapper.addEventListener('touchend', function(event) {
            if (dragging) {
                event.preventDefault();
                update(event.changedTouches[0].clientX, true);
                finish();
            }
        }, { passive: false });
        wrapper.addEventListener('touchcancel', function() {
            if (dragging) {
                finish();
            }
        });

        // Mouse support, for testing in a desktop browser.
        wrapper.addEventListener('mousedown', function(event) {
            if (!onBar(event.clientY)) {
                return;
            }
            event.preventDefault();
            begin();
            update(event.clientX, false);
            var move = function(moveEvent) {
                update(moveEvent.clientX, false);
            };
            var up = function(upEvent) {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
                update(upEvent.clientX, true);
                self.suppressNextClick = true;
                setTimeout(function() { self.suppressNextClick = false; }, 0);
                finish();
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        });
    },

    setBrightness: function(groupNum, bri, isFinal) {
        var self = this;
        if (this.groups[groupNum] === undefined) {
            return;
        }
        this.pendingBrightness[groupNum] = { bri: bri, until: Date.now() + Number(this.config.toggleConfirmTimeout) };

        var send = function() {
            self.brightnessSendTimer = null;
            self.lastBrightnessSent = Date.now();
            self.sendSocketNotification('SET_GROUP_BRIGHTNESS', { num: groupNum, bri: self.pendingBrightness[groupNum].bri });
        };
        clearTimeout(this.brightnessSendTimer);
        var wait = Number(this.config.brightnessThrottle) - (Date.now() - this.lastBrightnessSent);
        if (isFinal || wait <= 0) {
            send();
        } else {
            this.brightnessSendTimer = setTimeout(send, wait);
        }
    },

    /*
     * Keep rooms showing the brightness set from the mirror until the bridge reports it, as for toggles.
     */
    applyPendingBrightness: function(groups, lights, fromBridge) {
        for (const [groupNum, pending] of Object.entries(this.pendingBrightness)) {
            var group = groups[groupNum];
            if (!group || Date.now() > pending.until) {
                delete this.pendingBrightness[groupNum];
                continue;
            }
            var onLights = group.lights.map(function(lightId) { return lights[lightId]; })
                .filter(function(light) { return light && light.state.on; });
            var confirmed = onLights.every(function(light) { return Math.abs(light.state.bri - pending.bri) <= 2; });
            if (fromBridge && confirmed && !this.brightnessDragging) {
                delete this.pendingBrightness[groupNum];
                continue;
            }
            onLights.forEach(function(light) { light.state.bri = pending.bri; });
        }
    },

    applyGroupPower: function(groups, lights, groupNum, on) {
        var group = groups[groupNum];
        if (!group) {
            return;
        }
        group.state.all_on = on;
        group.state.any_on = on;
        group.lights.forEach(function(lightId) {
            var light = lights[lightId];
            if (light && light.state.reachable !== false) {
                light.state.on = on;
            }
        });
    },

    /*
     * Keep tapped rooms showing their new state until the bridge reports it, so a poll or event read just
     * before the change landed doesn't flip the tile back.
     */
    applyPendingToggles: function(groups, lights) {
        for (const [groupNum, pending] of Object.entries(this.pendingToggles)) {
            var group = groups[groupNum];
            if (!group || Date.now() > pending.until || group.state.any_on === pending.on) {
                delete this.pendingToggles[groupNum];
                continue;
            }
            this.applyGroupPower(groups, lights, groupNum, pending.on);
        }
    },

    renderGrid: function() {
        var groups = this.groups;

        var dataArr = [];
        for (const tuple of Object.entries(groups)) {
            dataArr.push(tuple);
        }
        dataArr.sort((t1, t2) => (this.config.displayFilter.indexOf(t1[1].name) > this.config.displayFilter.indexOf(t2[1].name)) ? 1 : -1);

        this.hbDataArr = [];
        var self = this;
        for (const [groupNumber, item] of dataArr) {
            //console.log('initial item is', item);
            var hbData = {
                rows: []
            };

            var itemColorData = item.action;
            var type = item.type.toLowerCase();

            var isOn = false;
            var allOn = false;
            var anyOn = false;

            var itemBrightness = 0;
            var itemBrightnessInPercent = 0;
            var itemBrightnessStyle = '';
            var lightText = false;

            allOn = item.state.all_on;
            anyOn = item.state.any_on;
            isOn = allOn || anyOn;

            // calculate colors for gradient or solid background

            var colorStyle = false;
            var lightOrDark = 'dark'; // default
            var lightsOn = 0;
            var contrast;

            var hasColors = (itemColorData.colormode) && ((itemColorData.colormode === 'xy') || (itemColorData.colormode === 'hs'));

            if (hasColors && isOn) {
                // colored lights

                // calculate contrast so we know whether to show a light or dark text

                var mainLight = { state: itemColorData };
                var mainLightColor = self.getHueColorStyle(mainLight);
                if (mainLightColor.colorRgb) {
                    contrast = self.contrast([255, 255, 255], [mainLightColor.colorRgb.r, mainLightColor.colorRgb.g, mainLightColor.colorRgb.b]);
                    if (contrast <= 1.5) {
                        // use dark text color
                        lightOrDark = 'dark';
                    } else {
                        // use light text color
                        lightOrDark = 'light';
                    }
                }

                // gradient background for groups

                var colorRgbArr = [];
                var groupLights = item.lights;

                for (j = 0; j < groupLights.length; j++) {
                    var lightId = groupLights[j];
                    var light = self.lights[lightId];
                    if (light) {
                        if (light.state.on) {
                            itemBrightness += light.state.bri;
                            var lightColor = self.getHueColorStyle(light);
                            if (lightColor.colorHex) {
                                colorRgbArr.push([
                                    lightColor.colorRgb.r,
                                    lightColor.colorRgb.g,
                                    lightColor.colorRgb.b
                                ]);
                            }
                        }
                    }
                }

                if (colorRgbArr.length > 0) {
                    // create gradient background color

                    var colorPercent = 100;

                    // sort colors (be aware that this removes duplicate colors)
                    var colorRgbSortedArr = (colorRgbArr.length > 1) ? self.sortColors(colorRgbArr) : colorRgbArr;

                    if (typeof colorRgbSortedArr === 'undefined') {
                        // all colors are the same
                        colorRgbSortedArr = colorRgbArr;
                    }

                    // set percentage
                    if (colorRgbSortedArr.length > 1) {
                        colorPercent = Math.round(100/parseInt((colorRgbSortedArr.length - 1)));
                    }

                    // override contrast settings based on sorted colors
                    contrast = self.contrast([255, 255, 255], [colorRgbSortedArr[0][0], colorRgbSortedArr[0][1], colorRgbSortedArr[0][2]]);
                    if (contrast <= 2.0) {
                        // use dark text color
                        lightOrDark = 'dark';
                    } else {
                        // use light text color
                        lightOrDark = 'light';
                    }

                    lightsOn = colorRgbArr.length;

                    for (j = 0; j < colorRgbSortedArr.length; j++) {

                        if (colorRgbSortedArr.length > 1) {
                            // background gradient
                            if (j == 0) {
                                colorStyle = 'background: linear-gradient(to right, ' + self.rgbToHexAlt(colorRgbSortedArr[j]) + ' 0%';
                            } else {
                                colorStyle += ', ' + self.rgbToHexAlt(colorRgbSortedArr[j]) + ' ' + (colorPercent * j) + '%';
                            }
                        } else {
                            // solid background color
                            colorStyle = 'background-color: ' + self.rgbToHexAlt(colorRgbSortedArr[j]) + ';';
                        }

                    }

                    if (colorRgbSortedArr.length > 1) {
                        colorStyle += ');';
                    }

                    itemBrightness = itemBrightness / lightsOn;

                }


            } else if (isOn) {
                // white lights
                // groups
                var groupLights = item.lights;

                for (j = 0; j < groupLights.length; j++) {
                    var lightId = groupLights[j];
                    var light = self.lights[lightId];
                    if (light) {
                        if (light.state.on) {
                            itemBrightness += light.state.bri;
                            lightsOn++;
                        }
                    }
                }
            }

            // calculate brightness value in percent

            if (isOn) {
                itemBrightnessInPercent = Math.ceil(100/254 * itemBrightness);

                itemBrightnessStyle = self.brightnessBarWidth(itemBrightnessInPercent);
            }

            // set light text (only relevant for groups)
            if (allOn) {
                lightText = 'All lights are on';
            } else if (anyOn) {
                if (lightsOn > 1) {
                    lightText = lightsOn + ' lights are on';
                } else {
                    lightText = lightsOn + ' light is on';
                }
            } else {
                lightText = 'All lights are off';
            }

            // set class for row

            var itemClass = self.classNames(
                isOn ? 'on' : 'off',
                colorStyle ? 'colored-' + lightOrDark : ''
            );

            // push data to HB object

            var rowObj = {
                isOn: isOn,
                isMinimal: false,
                isMinimalUltra: false,
                name: item.name,
                class: itemClass,
                colorStyle,
                lightText,
                itemBrightnessStyle
            };

            //console.log('creating an item for', item)
            self.groupNumLookup[item.name] = parseInt(groupNumber);

            hbData.rows.push(rowObj);

            // Push hbData into storage array
            self.hbDataArr.push(hbData);
        }


    },

    brightnessBarWidth: function(percent) {
        // some weird tweaks based on what I saw in the Hue app
        if (percent < 91) {
            return 'calc(' + (percent - 1) + '% + 20px)';
        } else if (percent > 97) {
            return '100%';
        }
        return percent + '%';
    },

    getData: function() {
        if (!this.sleeping) {
            if (this.config.user === '') {
                this.errMsg = 'Please add your Hue user to the MagicMirror config.js file.';
                this.updateDom();
            } else {
                this.sendSocketNotification('MMM_HUE_LIGHTS_GET', {
                    bridgeIp: this.config.bridgeIp,
                    user: this.config.user,
                    cameraLights: this.config.cameraLights
                });
            }

        }

    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === 'MMM_HUE_LIGHTS_DATA') {
            this.processHueData(payload);
        } else if (notification === 'MMM_HUE_LIGHTS_DATA_ERROR') {
            this.errMsg = payload;
            this.updateDom();
        } else if (notification === 'LIGHTS_TURNED_ON' || notification === 'LIGHTS_TURNED_OFF') {
            this.getData();
        } else if (notification === 'BRIGHTNESS_FAILED') {
            Log.error(this.name + ': could not set brightness of group ' + payload.num + ': ' + payload.error);
            delete this.pendingBrightness[payload.num];
            this.getData();
        } else if (notification === 'LIGHTS_TOGGLE_FAILED') {
            // Drop the optimistic state so the next read puts the tile back as it really is.
            Log.error(this.name + ': could not switch group ' + payload.num + ': ' + payload.error);
            delete this.pendingToggles[payload.num];
            this.getData();
        }
    },

    notificationReceived: function(notification, payload, sender) {
        if (sender?.name == 'MMM-Photobooth') {
            if (notification == 'LIGHTS_ON' && !this.cameraDeployed) {
                this.cameraDeployed = true; 
                // If a slider preview is showing, the lights are already the preview white, so save the
                // state from before the preview instead.
                const body = this.previewState || this.cameraLightStates;
                this.previewState = null;
                console.log("recieved lights on notification, camera is deployed?", this.cameraDeployed)
                console.log('Sending a notification to photobooth to save light state.')
                this.sendNotification('SAVE_LIGHT_STATE', body); // Send to photobooth app

                this.sendSocketNotification('SWITCH_CAMERA_WHITE', payload);
            } else if (notification == 'REVERSE_LIGHTS_BACK' && this.cameraDeployed) { // This should have the color the lights were in the payload
                // Fill in any light the photobooth's saved copy lacks from this module's own copy.
                const savedStates = Object.assign({}, this.cameraLightStates, payload);
                this.sendSocketNotification('SWITCH_CAMERA_COLOR', savedStates);
                this.rememberRestoredCameraState(savedStates);
                this.cameraDeployed = false; 
            } else if (notification == 'PREVIEW_TEMP' && !this.cameraDeployed) {
                // Until the first bridge poll arrives there is no state to restore afterwards, so skip the preview.
                if (!this.cameraLightStates) {
                    console.log('No camera light state yet, skipping preview');
                    return;
                }
                if (!this.previewState) {
                    this.previewState = this.cameraLightStates;
                }
                this.sendSocketNotification('SWITCH_CAMERA_WHITE', payload);
            } else if (notification == 'END_PREVIEW' && this.previewState && !this.cameraDeployed) {
                this.sendSocketNotification('SWITCH_CAMERA_COLOR', this.previewState);
                this.rememberRestoredCameraState(this.previewState);
                this.previewState = null;
            } else if (notification == 'CHANGE_TEMP' && this.cameraDeployed) {
                console.log("just changing tempurate")
                this.sendSocketNotification('SWITCH_CAMERA_WHITE', payload);
            }
        }
    },

    cameraInUse: function() {
        return this.cameraDeployed || Boolean(this.previewState) || Date.now() <= this.cameraStateFrozenUntil;
    },

    /*
     * Remember the camera lights' states while the camera isn't using them, so they can be restored afterwards.
     * While it is, replace what the bridge reports for them with the remembered states, so the photobooth's
     * white light never shows up in the display.
     */
    trackCameraLights: function(lights) {
        var cameraLights = this.config.cameraLights || {};

        if (!this.cameraInUse()) {
            var states = {};
            for (const [role, lightId] of Object.entries(cameraLights)) {
                if (lights[lightId]) {
                    states[role] = Object.assign({}, lights[lightId].state);
                }
            }
            this.cameraLightStates = Object.keys(states).length > 0 ? states : null;
            return;
        }

        if (!this.cameraLightStates) {
            return;
        }
        for (const [role, lightId] of Object.entries(cameraLights)) {
            var saved = this.cameraLightStates[role];
            if (lights[lightId] && saved) {
                // Reachability is live information, not something the camera changed.
                lights[lightId].state = Object.assign({}, saved, { reachable: lights[lightId].state.reachable });
            }
        }
    },

    // After a restore the bridge takes a moment to settle and a poll may already be in flight with the old
    // colour, so trust the state that was just restored until the next couple of polls.
    rememberRestoredCameraState: function(restoredState) {
        this.cameraLightStates = restoredState;
        this.cameraStateFrozenUntil = Date.now() + 2 * Number(this.config.updateInterval);
    },

    suspend: function() {
        // this method is triggered when a module is hidden using this.hide()

        this.sleeping = true;

    },

    resume: function() {
        // this method is triggered when a module is shown using this.show()

        var self = this;

        if (this.sleeping) {

            this.sleeping = false;

            // get new data
            this.getData();
        }

    },

    processHueData: function(data) {
        //console.log(data)
        var self = this;

        var displayMode = this.config.displayMode;
        var displayFilter = this.config.displayFilter;
        var hideFilter = this.config.hideFilter;

        var renderUi = true;
        // A previous error replaced the whole display, so redraw even if the lights haven't changed since.
        var forceRender = this.errMsg !== '';

        var oldLights = this.lights;
        var oldGroups = this.groups;
        var numberOfOldLights = Object.keys(oldLights).length;
        var numberOfOldGroups = Object.keys(oldGroups).length;

        var lights = data.lights;
        var groups = data.groups;

        this.trackCameraLights(data.lights);

        // for the groups, let's immediately filter out anything that doesn't have a type of 'Room'

        Object.keys(data.groups).forEach(function(key) {
            var itemType = data.groups[key].type.toLowerCase();
            if (!(itemType === 'room' || itemType === 'zone')) {
                delete data.groups[key];
            }
        });

        var itemsToFilter = (displayMode === 'lights') ? lights : groups;
        var itemsFilteredOut = 0;

        // check for positive filtering

        if (this.isArray(displayFilter)) {

            if (displayFilter.length > 0) {
                // if the array is empty, we'll assume they want to see all lights/groups

                if (displayFilter[0] !== 'all') {

                    Object.keys(itemsToFilter).forEach(function(key) {

                        var itemName = itemsToFilter[key].name.toLowerCase();
                        var deleteItem = true;

                        for (let i = 0; i < displayFilter.length; i++) {
                            var filterString = displayFilter[i].toLowerCase().trim();
                            if (itemName.indexOf(filterString) > -1) {
                                // this should NOT be filtered out
                                deleteItem = false;
                            }
                        }

                        if (deleteItem) {
                            itemsFilteredOut++;
                            delete itemsToFilter[key];
                        }

                    });

                }

            }

        } else if (this.isString(displayFilter)) {
            // we will be nice and assume the user meant for this to be an array with the string inside it

            if (displayFilter !== 'all') {
                // filter based on the string

                var filterString = displayFilter.toLowerCase().trim();

                Object.keys(itemsToFilter).forEach(function(key) {
                    var itemName = itemsToFilter[key].name.toLowerCase();
                    if (itemName.indexOf(filterString) < 0) {
                        // this should be filtered out
                        itemsFilteredOut++;
                        delete itemsToFilter[key];
                    }
                });

            }

        }

        // check for negative filtering

        if (this.isArray(hideFilter)) {
            if (hideFilter.length > 0) {

                Object.keys(itemsToFilter).forEach(function(key) {

                    var itemName = itemsToFilter[key].name.toLowerCase();
                    var deleteItem = false;

                    for (let i = 0; i < hideFilter.length; i++) {
                        var filterString = hideFilter[i].toLowerCase().trim();
                        if (itemName.indexOf(filterString) > -1) {
                            // this should be filtered out
                            deleteItem = true;
                        }
                    }

                    if (deleteItem) {
                        itemsFilteredOut++;
                        delete itemsToFilter[key];
                    }

                });

            }
        }

        var numberOfLights = (lights) ? Object.keys(data.lights).length : 0;
        var numberOfGroups = (groups) ? Object.keys(data.groups).length : 0;

        // check if lights of each group is reachable
        // no reachable lights will be "marked" as off
        Object.values(data.groups).forEach(function (group, index) {

            var numberOfLightsInGroup = group.lights.length;
            var any_on = false;
            var all_on = numberOfLightsInGroup > 0;

            for (var i = 0; i < numberOfLightsInGroup; i++) {
                var hueLightID = group.lights[i];

                var lightState = data.lights[hueLightID] && data.lights[hueLightID].state;
                if (!lightState) {
                    continue;
                }

                if (lightState.reachable == false) {
                    // if light is not reachable
                    lightState.on = false;
                    forceRender = true;
                }

                if (lightState.on == true) {
                    any_on = true;
                } else {
                    all_on = false;
                }
            }

            // Recomputed from the lights rather than trusted from the bridge, so unreachable lights and the
            // camera light substitution in trackCameraLights are reflected.
            group.state.any_on = any_on;
            group.state.all_on = all_on && any_on;

        });

        this.applyPendingToggles(groups, lights);
        this.applyPendingBrightness(groups, lights, true);

        // check old data to make sure we're not re-rendering the UI for no reason
        if (this.loaded) {
            if (numberOfOldLights !== numberOfLights) {
                // number of lights changed (update dom)
            } else if (numberOfOldGroups !== numberOfGroups) {
                // number of groups changed (update dom)
            } else if (forceRender) {
                // force render (update dom)
            } else {
                // compare status of lights
                if ((this.jsonEqual(oldLights,lights)) && (this.jsonEqual(oldGroups,groups))) {
                    renderUi = false;
                }
            }

        }

        this.loaded = true;
        this.lights = lights;
        this.groups = groups;

        if (renderUi) {
            if (itemsFilteredOut > 0) {
                if ((displayMode === 'lights') && (numberOfLights === 0)) {
                    this.errMsg = 'No Hue lights were found<br>with the filter(s) you specified.';
                } else if ((displayMode === 'groups') && (numberOfGroups === 0)) {
                    this.errMsg = 'No Hue light groups were found<br>with the filter(s) you specified.';
                }
            } else if ((displayMode === 'lights') && (numberOfLights === 0)) {
                this.errMsg = 'You have no Hue lights.';
            } else if ((displayMode === 'groups') && (numberOfGroups === 0)) {
                this.errMsg = 'You have no Hue light groups.';
            } else {
                this.errMsg = '';
            }

            // Redrawing mid-drag would replace the bar under the finger, so wait until it is let go.
            if (this.brightnessDragging) {
                this.renderAfterDrag = true;
            } else {
                this.updateDom();
            }
        }
    },

    getHueColorStyle: function(item) {

        /*

        Hue lights use HSB color space for colormode ct, not RGB
        This is used for regular color light bulbs

        item.state.hue = The hue value to set light to. The hue value is a wrapping value between 0 and 65535. Both 0 and 65535 are red, 25500 is green and 46920 is blue.
        item.state.bri = Brightness of the light. This is a scale from the minimum brightness the light is capable of, 1, to the maximum capable brightness, 254.
        item.state.sat = Saturation of the light. 254 is the most saturated (colored) and 0 is the least saturated (white).

        Hue lights use CIE color space for colormode xy
        This is used for color lightstrips and blooms

        item.state.xy = The x and y coordinates of a color in CIE color space.The first entry is the x coordinate and the second entry is the y coordinate. Both x and y must be between 0 and 1.

        item.state.colormode = Indicates the color mode in which the light is working, this is the last command type it received. Values are “hs” for Hue and Saturation, “xy” for XY and “ct” for Color Temperature. This parameter is only present when the light supports at least one of the values.

        */

        var colorRgb = false;
        var colorHex = false;
        var colorStyle = false;

        if (item.state.colormode && item.state.xy && item.state.bri) {
            // colored light, with x, y, and bri values
            colorRgb = this.XYtoRGB(item.state.xy[0], item.state.xy[1],item.state.bri);
            colorHex = this.rgbToHex(colorRgb);
            if (colorHex !== '#000000') {
                colorStyle = 'color: ' + colorHex + '; border-color: ' + colorHex + ' !important;';
            }
        } else if (item.state.bri) {
            // white light with bri value
            // just a hacky conversion to show brightness
            var bri = Math.floor(100/255 * item.state.bri);
            if (bri > 0) {
                if (bri > 98) {
                    bri = '1';
                } else {
                    bri = '0.' + bri;
                }
                colorStyle = 'color: #fff; opacity: ' + bri +';';
            }
        }

        return {
            colorHex,
            colorStyle,
            colorRgb
        };

    },

    isString: function(val) {
        return typeof val === 'string' || val instanceof String;
    },

    isArray: function(val) {
        return Array.isArray(val);
    },

    // https://github.com/JedWatson/classnames/
    classNames: function() {
        var classes = [];

        for (var i = 0; i < arguments.length; i++) {
            var arg = arguments[i];
            if (!arg) continue;

            var argType = typeof arg;

            if (argType === 'string' || argType === 'number') {
                classes.push(arg);
            } else if (Array.isArray(arg) && arg.length) {
                var inner = this.classNames.apply(this, arg);
                if (inner) {
                    classes.push(inner);
                }
            } else if (argType === 'object') {
                for (var key in arg) {
                    if (Object.prototype.hasOwnProperty.call(arg, key) && arg[key]) {
                        classes.push(key);
                    }
                }
            }
        }

        return classes.join(' ');
    },

    jsonEqual: function(a,b) {
        return JSON.stringify(a) === JSON.stringify(b);
    },

    XYtoRGB: function(x, y, brightness) {
        // convert X, Y, bri colors to RGB

        if (brightness === undefined) {
            brightness = 254;
        }

        var z = 1.0 - x - y;
        var Y = brightness;
        //var Y = (brightness / 254).toFixed(2);
        var X = (Y / y) * x;
        var Z = (Y / y) * z;

        // convert to RGB using Wide RGB D65 conversion
        var red     =  X * 1.656492 - Y * 0.354851 - Z * 0.255038;
        var green   = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
        var blue    =  X * 0.051713 - Y * 0.121364 + Z * 1.011530;

        // if red, green or blue is larger than 1.0 set it back to the maximum of 1.0
        if (red > blue && red > green && red > 1.0) {
            green = green / red;
            blue = blue / red;
            red = 1.0;
        } else if (green > blue && green > red && green > 1.0) {
            red = red / green;
            blue = blue / green;
            green = 1.0;
        } else if (blue > red && blue > green && blue > 1.0) {
            red = red / blue;
            green = green / blue;
            blue = 1.0;
        }

        // reverse gamma correction
        red     = red <= 0.0031308 ? 12.92 * red : (1.0 + 0.055) * Math.pow(red, (1.0 / 2.4)) - 0.055;
        green   = green <= 0.0031308 ? 12.92 * green : (1.0 + 0.055) * Math.pow(green, (1.0 / 2.4)) - 0.055;
        blue    = blue <= 0.0031308 ? 12.92 * blue : (1.0 + 0.055) * Math.pow(blue, (1.0 / 2.4)) - 0.055;

        if (red > blue && red > green) {
            // red is biggest
            if (red > 1.0) {
                green = green / red;
                blue = blue / red;
                red = 1.0;
            }
        } else if (green > blue && green > red) {
            // green is biggest
            if (green > 1.0) {
                red = red / green;
                blue = blue / green;
                green = 1.0;
            }
        } else if (blue > red && blue > green) {
            // blue is biggest
            if (blue > 1.0) {
                red = red / blue;
                green = green / blue;
                blue = 1.0;
            }
        }

        // convert normalized decimal to decimal
        red     = Math.round(red * 255);
        green   = Math.round(green * 255);
        blue    = Math.round(blue * 255);

        if (isNaN(red)) {
            red = 0;
        }

        if (isNaN(green)){
            green = 0;
        }

        if (isNaN(blue)) {
            blue = 0;
        }

        if (red < 0) {
            red = 0;
        }

        if (green < 0) {
            green = 0;
        }

        if (blue < 0) {
            blue = 0;
        }

        return {
            r: red,
            g: green,
            b: blue
        }
    },

    luminanace: function(r,g,b) {
        var a = [r, g, b].map(function (v) {
            v /= 255;
            return v <= 0.03928
                ? v / 12.92
                : Math.pow( (v + 0.055) / 1.055, 2.4 );
            });

        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;

    },

    contrast: function(rgb1,rgb2) {
        l1 = this.luminanace(rgb1[0], rgb1[1], rgb1[2]) + 0.05;
        l2 = this.luminanace(rgb2[0], rgb2[1], rgb2[2]) + 0.05;

        return (Math.max(l1,l2) / Math.min(l1,l2));
    },

    rgbToHsl: function(c) {
        var r = c[0]/255, g = c[1]/255, b = c[2]/255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, l = (max + min) / 2;

        if(max == min) {
            h = s = 0; // achromatic
        } else {
            var d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch(max){
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }

        return new Array(h * 360, s * 100, l * 100);

    },

    colorDistance: function(color1, color2) {
        // This is actually the square of the distance but this doesn't matter for sorting.
        var result = 0;
        for (var i = 0; i < color1.length; i++) {
            result += (color1[i] - color2[i]) * (color1[i] - color2[i]);
        }
        return result;
    },

    sortColors: function(colors) {
        // Calculate distance between each color
        var distances = [];

        for (var i = 0; i < colors.length; i++) {
            distances[i] = [];
            for (var j = 0; j < i; j++) {
                distances.push([colors[i], colors[j], this.colorDistance(colors[i], colors[j])]);
            }
        }

        distances.sort(function(a, b) {
            return a[2] - b[2];
        });

        // Put each color into separate cluster initially
        var colorToCluster = {};
        for (var i = 0; i < colors.length; i++){
            colorToCluster[colors[i]] = [colors[i]];
        }

        // Merge clusters, starting with lowest distances
        var lastCluster;

        for (var i = 0; i < distances.length; i++) {
            var color1 = distances[i][0];
            var color2 = distances[i][1];

            var cluster1 = colorToCluster[color1];
            var cluster2 = colorToCluster[color2];

            if (!cluster1 || !cluster2 || cluster1 == cluster2)
                continue;

            // Make sure color1 is at the end of its cluster and
            // color2 at the beginning.
            if (color1 != cluster1[cluster1.length - 1]) {
                cluster1.reverse();
            }

            if (color2 != cluster2[0]) {
                cluster2.reverse();
            }

            // Merge cluster2 into cluster1
            cluster1.push.apply(cluster1, cluster2);

            delete colorToCluster[color1];
            delete colorToCluster[color2];

            colorToCluster[cluster1[0]] = cluster1;
            colorToCluster[cluster1[cluster1.length - 1]] = cluster1;

            lastCluster = cluster1;
        }

        // By now all colors should be in one cluster
        return lastCluster;
    },

    rgbToHex: function(rgb) {
        // when rgb is an object
        return '#' + ((1 << 24) + (rgb.r << 16) + (rgb.g << 8) + rgb.b).toString(16).slice(1);
    },

    rgbToHexAlt: function(rgb) {
        // when rgb is an array
        return '#' + ((1 << 24) + (rgb[0] << 16) + (rgb[1] << 8) + rgb[2]).toString(16).slice(1);
    },

    scheduleUpdate: function() {
        var self = this;
        setInterval(() => {
            self.getData();
        }, Number(self.config.updateInterval));
    }

});
