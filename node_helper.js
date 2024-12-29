var NodeHelper = require('node_helper');
var request = require('request');
const fetch = require('node-fetch');

module.exports = NodeHelper.create({

    start: function() {
        console.log('Starting node_helper for module [' + this.name + ']');
    },

    turnOffAllLights: function (payload) {
        var self = this;
        fetch(payload.url, {
            method: 'PUT',
            body: JSON.stringify({
                "on": false
            })    
        })
        .then(results => {
            self.sendSocketNotification("LIGHTS_TURNED_OFF", payload.num);
        })
        .catch((error) => {
            self.sendSocketNotification("LIGHTS_TURNED_OFF", error);
        });
    },

    turnOnAllLights: function(payload) {
        let self = this;
        fetch(payload.url, {
            method: 'PUT',
            body: JSON.stringify({
                "on": true
            })    
        })
        .then(results => {
            self.sendSocketNotification("LIGHTS_TURNED_ON", payload.num);
        })
        .catch((error) => {
            self.sendSocketNotification("LIGHTS_TURNED_ON", error);
        });
    },

    setLightWhite: function(type) {
        console.log("changing the color back to white")
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
        var url1 = `http://192.168.0.119/api/cI9FSbnf7ejbHQ1d3wDUtSf43EYQIvs9r1FDvYCo/lights/${idLeft}/state`;
        var url2 = `http://192.168.0.119/api/cI9FSbnf7ejbHQ1d3wDUtSf43EYQIvs9r1FDvYCo/lights/${idRight}/state`;

        request({
            url : url1,
            method :"PUT",
            headers : {
                "content-type": "application/json",
            },
            body: {
                'ct': ct
            },
            json: true,
            },
            function(err, res, body) {
                console.log(body);
            })

        request({
            url : url2,
            method :"PUT",
            headers : {
                "content-type": "application/json",
            },
            body: {
                'ct': ct
            },
            json: true,
            },
            function(err, res, body) {
                console.log(body);
            })
    },

    setLightColor: function(payload) {
        console.log("setting lights back to stored state, with payload:", payload)
        var idLeft = 21;
        var idRight = 22;
        var idBulb = 47;
        var url1 = `http://192.168.0.119/api/cI9FSbnf7ejbHQ1d3wDUtSf43EYQIvs9r1FDvYCo/lights/${idLeft}/state`;
        var url2 = `http://192.168.0.119/api/cI9FSbnf7ejbHQ1d3wDUtSf43EYQIvs9r1FDvYCo/lights/${idRight}/state`;
        var url3 = `http://192.168.0.119/api/cI9FSbnf7ejbHQ1d3wDUtSf43EYQIvs9r1FDvYCo/lights/${idBulb}/state`;

        request({
            url : url1,
            method :"PUT",
            headers : {
                "content-type": "application/json",
            },
            body: {
                "bri": payload.left.bri,
                "hue": payload.left.hue,
                "sat": payload.left.sat,
                "xy": payload.left.xy,
                "ct": payload.left.ct,
                "colormode": payload.left.colorMode,
            },
            json: true,
            },
            function(err, res, body) {
                console.log(body);
            })

        request({
            url : url2,
            method :"PUT",
            headers : {
                "content-type": "application/json",
            },
            body: {
                "bri": payload.right.bri,
                "hue": payload.right.hue,
                "sat": payload.right.sat,
                "xy": payload.right.xy,
                "ct": payload.right.ct,
                "colormode": payload.right.colorMode,
            },
            json: true,
            },
            function(err, res, body) {
                console.log(body);
            })

        request({
                url : url3,
                method :"PUT",
                headers : {
                    "content-type": "application/json",
                },
                body: {
                    "bri": payload.right.bri,
                    "hue": payload.right.hue,
                    "sat": payload.right.sat,
                    "xy": payload.right.xy,
                    "ct": payload.right.ct,
                    "colormode": payload.right.colorMode,
                },
                json: true,
                },
                function(err, res, body) {
                    console.log(body);
                })
    },

    socketNotificationReceived: function(notification, payload) {
        console.log('notif recieved', notification)
        if (notification === 'MMM_HUE_LIGHTS_GET') {

            var bridgeIp = payload.bridgeIp;
            var user = payload.user;

            var url = 'http://' + bridgeIp + '/api/' + user;
            var self = this;

            request(url, {method: 'GET'}, function(err, res, body) {

                if ((err) || (res.statusCode !== 200)) {
                    self.sendSocketNotification('MMM_HUE_LIGHTS_DATA_ERROR', 'Hue API Error: ' + err);
                } else {
                    if (body === {}) {
                        self.sendSocketNotification('MMM_HUE_LIGHTS_DATA_ERROR', 'Hue API Error: No Hue data was received.');
                    } else {
                        var data = JSON.parse(body);
                        self.sendSocketNotification('MMM_HUE_LIGHTS_DATA', data);
                    }
                }

            });

        } else if (notification === "TURN_OFF_LIGHTS") {
            this.turnOffAllLights(payload);
        } else if (notification === "TURN_ON_LIGHTS") {
            this.turnOnAllLights(payload);
        } else if (notification === "SWITCH_CAMERA_WHITE") {
            this.setLightWhite(payload)
        } else if (notification === "SWITCH_CAMERA_COLOR") {
            console.log("switching camera color back", payload)
            this.setLightColor(payload);
        }
    },
});