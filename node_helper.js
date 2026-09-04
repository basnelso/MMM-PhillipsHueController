var NodeHelper = require('node_helper');
var request = require('request');
const https = require('https');

// Philips Hue bridges use a certificate that Node.js does not
// automatically trust. This disables certificate verification
// ONLY for requests made through this Hue agent.
const hueAgent = new https.Agent({
    rejectUnauthorized: false
});

let fetch;

// Dynamically import node-fetch (v3 is ESM-only)
(async () => {
    fetch = (await import('node-fetch')).default;
})();

module.exports = NodeHelper.create({

    start: function() {
        console.log('Starting node_helper for module [' + this.name + ']');

        // These are populated when MMM_HUE_LIGHTS_GET is received.
        this.bridgeIp = null;
        this.user = null;
    },

    /*
     * Store the Hue configuration received from the main module.
     */
    setHueConfig: function(payload) {
        if (payload.bridgeIp) {
            this.bridgeIp = payload.bridgeIp;
        }

        if (payload.user) {
            this.user = payload.user;
        }

        console.log('Hue bridge configured:', this.bridgeIp);
    },

    /*
     * Build a Hue API URL using the configured bridge and user.
     */
    hueUrl: function(path) {
        return `https://${this.bridgeIp}/api/${this.user}/${path}`;
    },

    /*
     * Turn off a Hue group.
     */
    turnOffAllLights: function(payload) {
        var self = this;

        if (!fetch) {
            self.sendSocketNotification(
                "LIGHTS_TURNED_OFF",
                "Hue API Error: node-fetch is not ready yet."
            );
            return;
        }

        fetch(payload.url, {
            method: 'PUT',
            agent: hueAgent,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "on": false
            })
        })
        .then(async results => {
            if (!results.ok) {
                const body = await results.text();
                throw new Error(
                    `Hue API returned ${results.status}: ${body}`
                );
            }

            self.sendSocketNotification("LIGHTS_TURNED_OFF", payload.num);
        })
        .catch((error) => {
            console.error("Hue API error turning lights off:", error);
            self.sendSocketNotification(
                "LIGHTS_TURNED_OFF",
                "Hue API Error: " + error.message
            );
        });
    },

    /*
     * Turn on a Hue group.
     */
    turnOnAllLights: function(payload) {
        var self = this;

        if (!fetch) {
            self.sendSocketNotification(
                "LIGHTS_TURNED_ON",
                "Hue API Error: node-fetch is not ready yet."
            );
            return;
        }

        fetch(payload.url, {
            method: 'PUT',
            agent: hueAgent,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "on": true
            })
        })
        .then(async results => {
            if (!results.ok) {
                const body = await results.text();
                throw new Error(
                    `Hue API returned ${results.status}: ${body}`
                );
            }

            self.sendSocketNotification("LIGHTS_TURNED_ON", payload.num);
        })
        .catch((error) => {
            console.error("Hue API error turning lights on:", error);
            self.sendSocketNotification(
                "LIGHTS_TURNED_ON",
                "Hue API Error: " + error.message
            );
        });
    },

    /*
     * Set the three camera lights to white.
     *
     * Existing camera light IDs:
     * 21 = left
     * 22 = right
     * 47 = bulb
     */
    setLightWhite: function(type) {
        console.log("Changing the color back to white");

        if (!this.bridgeIp || !this.user) {
            console.error("Hue configuration has not been initialized.");
            return;
        }

        var ct = 153;

        if (type == 'cool') {
            ct = 153;
        } else if (type == 'medium') {
            ct = 260;
        } else if (type == 'warm') {
            ct = 360;
        }

        var idLeft = 21;
        var idRight = 22;
        var idBulb = 47;

        var url1 = this.hueUrl(`lights/${idLeft}/state`);
        var url2 = this.hueUrl(`lights/${idRight}/state`);
        var url3 = this.hueUrl(`lights/${idBulb}/state`);

        var bri = 254;

        var body = {
            'ct': ct,
            'bri': bri
        };

        this.putHueState(url1, body, 'left camera light');
        this.putHueState(url2, body, 'right camera light');
        this.putHueState(url3, body, 'camera bulb');
    },

    /*
     * Restore the three camera lights to their previously stored states.
     */
    setLightColor: function(payload) {
        console.log(
            "Setting lights back to stored state, with payload:",
            payload
        );

        if (!this.bridgeIp || !this.user) {
            console.error("Hue configuration has not been initialized.");
            return;
        }

        var idLeft = 21;
        var idRight = 22;
        var idBulb = 47;

        var url1 = this.hueUrl(`lights/${idLeft}/state`);
        var url2 = this.hueUrl(`lights/${idRight}/state`);
        var url3 = this.hueUrl(`lights/${idBulb}/state`);

        var leftBody = {
            "bri": payload.left.bri,
            "hue": payload.left.hue,
            "sat": payload.left.sat,
            "xy": payload.left.xy,
            "ct": payload.left.ct,
            "colormode": payload.left.colorMode
        };

        var rightBody = {
            "bri": payload.right.bri,
            "hue": payload.right.hue,
            "sat": payload.right.sat,
            "xy": payload.right.xy,
            "ct": payload.right.ct,
            "colormode": payload.right.colorMode
        };

        /*
         * Your original code uses the RIGHT state for light 47,
         * so that behavior is intentionally preserved here.
         */
        var bulbBody = {
            "bri": payload.right.bri,
            "hue": payload.right.hue,
            "sat": payload.right.sat,
            "xy": payload.right.xy,
            "ct": payload.right.ct,
            "colormode": payload.right.colorMode
        };

        this.putHueState(url1, leftBody, 'left camera light');
        this.putHueState(url2, rightBody, 'right camera light');
        this.putHueState(url3, bulbBody, 'camera bulb');
    },

    /*
     * Helper for PUT requests to the Hue API.
     */
    putHueState: function(url, body, description) {
        request({
            url: url,
            method: "PUT",
            strictSSL: false,
            headers: {
                "content-type": "application/json"
            },
            body: body,
            json: true
        }, function(err, res, responseBody) {

            if (err) {
                console.error(
                    "Hue API error for " + description + ":",
                    err
                );
                return;
            }

            if (!res || res.statusCode < 200 || res.statusCode >= 300) {
                console.error(
                    "Hue API returned an error for " +
                    description + ":",
                    res ? res.statusCode : 'unknown',
                    responseBody
                );
                return;
            }

            console.log(
                "Hue updated " + description + ":",
                responseBody
            );
        });
    },

    socketNotificationReceived: function(notification, payload) {

        console.log('Notification received:', notification);

        /*
         * Initial Hue API request.
         *
         * This is where the main MagicMirror module passes:
         * bridgeIp
         * user
         */
        if (notification === 'MMM_HUE_LIGHTS_GET') {

            this.setHueConfig(payload);

            var bridgeIp = payload.bridgeIp;
            var user = payload.user;

            var url = `https://${bridgeIp}/api/${user}`;

            var self = this;

            request({
                url: url,
                method: 'GET',
                strictSSL: false
            }, function(err, res, body) {

                if (err) {
                    console.error("Hue API connection error:", err);

                    self.sendSocketNotification(
                        'MMM_HUE_LIGHTS_DATA_ERROR',
                        'Hue API Error: ' + err.message
                    );

                    return;
                }

                if (!res || res.statusCode !== 200) {

                    console.error(
                        "Hue API returned status:",
                        res ? res.statusCode : 'unknown',
                        body
                    );

                    self.sendSocketNotification(
                        'MMM_HUE_LIGHTS_DATA_ERROR',
                        'Hue API Error: HTTP ' +
                        (res ? res.statusCode : 'unknown')
                    );

                    return;
                }

                if (!body) {
                    self.sendSocketNotification(
                        'MMM_HUE_LIGHTS_DATA_ERROR',
                        'Hue API Error: No Hue data was received.'
                    );

                    return;
                }

                try {
                    var data = JSON.parse(body);

                    self.sendSocketNotification(
                        'MMM_HUE_LIGHTS_DATA',
                        data
                    );

                } catch (parseError) {

                    console.error(
                        "Unable to parse Hue API response:",
                        parseError
                    );

                    self.sendSocketNotification(
                        'MMM_HUE_LIGHTS_DATA_ERROR',
                        'Hue API Error: Invalid JSON response.'
                    );
                }
            });

        } else if (notification === "TURN_OFF_LIGHTS") {

            this.turnOffAllLights(payload);

        } else if (notification === "TURN_ON_LIGHTS") {

            this.turnOnAllLights(payload);

        } else if (notification === "SWITCH_CAMERA_WHITE") {

            this.setLightWhite(payload);

        } else if (notification === "SWITCH_CAMERA_COLOR") {

            console.log(
                "Switching camera color back:",
                payload
            );

            this.setLightColor(payload);
        }
    }
});
