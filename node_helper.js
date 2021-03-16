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

    socketNotificationReceived: function(notification, payload) {
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
        }
    }

});