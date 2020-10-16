const crypto = require("crypto");
const fetch = require('node-fetch');

const BLINK_API_HOST = "immedia-semi.com";

const CACHE = new Map();

//https://github.com/MattTW/BlinkMonitorProtocol

class BlinkAPI {
    constructor(email, password, clientUUID, pin = null, region = "prod") {
        this.email = email;
        this.password = password;
        this.clientUUID = clientUUID;
        this.pin = pin;
        this.region = region;
        this._log = console.log;
        this._log.info = console.info;
        this._log.debug = console.debug;
        this._log.error = console.error;
    }

    get log() {
        return this._log;
    }

    set log(customLog) {
        this._log = customLog;
    }

    init(email, password, clientUUID, pin = null, region = "prod", accountID = 0, clientID = 0) {
        this.email = email;
        this.password = password;
        this.clientUUID = clientUUID;
        this.pin = pin;
        this.region = region;
        this.accountID = accountID;
        this.clientID = clientID;
    }

    async get(path = '/', headers = {}, maxTTL) {
        return await this._request("GET", path, null, headers, maxTTL);
    }

    async post(path = '/', body = null, headers = {}) {
        return this._request("POST", path, body, headers);
    }

    async _request(method = "GET", path = '/', body = null, headers = {}, maxTTL = null) {

        if (CACHE.has(method + path) && maxTTL > 0) {
            let cache = CACHE.get(method + path);
            let lastModified = new Date(cache.headers.get('last-modified') || cache.headers.get('date') || new Date());
            if (lastModified.getTime() + (maxTTL * 1000) > Date.now() && cache._json) {
                return cache._json;
            }
        }

        headers = Object.assign({
            "User-Agent": "Blink/8854 CFNetwork/1202 Darwin/20.1.0",
            "app-build": "IOS_8854",
            "Locale": "en_US",
            "accept-language": "en_US",
            "Accept": "*/*",
        }, headers);
        if (this.token) headers["TOKEN_AUTH"] = this.token;

        const options = {method, headers};
        if (body) {
            options.body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
        }

        this.log.info(`${method} ${path}`);
        this.log.debug(options);
        let res = await fetch(`https://rest-${this.region || "prod"}.${BLINK_API_HOST}${path}`, options)
            .catch(e => {
                this.log.debug(JSON.stringify(e, null, 2));
                return Promise.reject(e)
            });

        // if the API call resulted in 401 Unauthorized, try logging in
        if (res.status === 401) {
            if (!this._avoidRetry) {
                if (this.email && this.password) {
                    this._avoidRetry = true;
                    await this.login(true);
                    res = await this._request(method, path, body, headers);
                    this._avoidRetry = false;
                    return res;
                }
            }
        }
        else if (this.status >= 400) {
            return Promise.reject(`${method} ${path} -- ${res.headers.get('status')}`)
        }
        else if (res.status <= 300) {
            if (method === "GET") {
                CACHE.set(method + path, res);
            }
        }

        if (res.headers.get('content-type') === 'application/json') {
            const json = await res.json();
            res._json = json; // stash it for the cache because .json() isn't re-callable
            this.log.debug(JSON.stringify(json));
            return json;
        }
        return res.arrayBuffer();
    }

    async login(force = false, email = null, password = null, clientUUID = null, client = {}) {
        if (!force && this.token) return;

        client = client || {};
        const data = {
            "app_version": client.appVersion || "6.1.1 (8854) #e06341d7f",
            "client_name": client.name || "unknown",
            "client_type": client.type || "ios",
            "device_identifier": client.device || "iPhone12,3",
            "email": email || this.email,
            "notification_key": client.notificationKey || crypto.randomBytes(32).toString("hex"),
            "os_version": client.os || "14.2",
            "password": password || this.password,
            "reauth": "true",
            "unique_id": clientUUID || this.clientUUID || require("crypto").randomBytes(16).toString("hex").toUpperCase().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")
        }

        const res = await this.post("/api/v4/account/login", data);

        // convenience function to avoid the business logic layer from having to handle this check constantly
        if (res && res.message !== "Unauthorized Access") {
            this.accountID = (res.account || {}).id || this.accountID;
            this.clientID = (res.client || {}).id || this.clientID;
            this.token = (res.authtoken || {}).authtoken || this.token;
            this.region = (res.region || {}).tier || this.region;

            if ((res.client || {}).verification_required && this.pin) await this.verify();
        }

        return res;
    }

    async verify(pin, clientID = 0, accountID = 0) {
        const data = {
            pin: pin || this.pin
        }
        return await this.post(`/api/v4/account/${accountID || this.accountID}/client/${clientID || this.clientID}/pin/verify`, data);
    }

    // {
    // "message": "The Blink Cloud service is operating normally.",
    // "message_code": 0,
    // "message_params": [],
    // "check_interval": 60,
    // "next_check_time": "2020-10-03T15:23:03Z",
    // "monitor_last_update": "2020-10-03T15:22:58Z",
    // "url": ""
    // }
    async getBlinkStatus(tier = "prod") {
        await this.login();
        return await this.get(`https://blinkstatus.net/api/v1/${tier}`)
    }

    // {}
    async getBlinkSupport() {
        await this.login();
        return await this.get(`/api/v2/support/ob_phone/`);
    }

    //{"message":"OK","code":103,"update_available":false,"update_required":false}
    async getVersion() {
        await this.login();
        return await this.get(`/api/v1/version`);
    }

    // {"preferred":"usu026","regions":{"usu026":{"display_order":1,"dns":"u026","friendly_name":"United States - EAST","registration":true},"usu019":{"display_order":2,"dns":"u019","friendly_name":"United States - CENTRAL","registration":true},"usu015":{"display_order":3,"dns":"u015","friendly_name":"United States - WEST","registration":true},"e003":{"display_order":4,"dns":"e003","friendly_name":"Europe","registration":true},"sg":{"display_order":5,"dns":"prsg","friendly_name":"Southeast Asia","registration":true}}}
    async getRegions(country = "US") {
        await this.login();
        return await this.get(`/regions?locale=${country}`);
    }

    // Accounts

    // {"catalina_app_enabled":true,"sm2_app_enabled":true,"snapshot_app_enabled":true,"owl_app_enabled":true,"legacy_account_mini":true}
    async getAccountOptions() {
        await this.login();
        return await this.get(`/api/v1/account/options`);
    }

    // {"notifications":{"low_battery":true,"camera_offline":true,"camera_usage":true,"scheduling":true,"motion":true,"sync_module_offline":true,"temperature":true,"doorbell":true,"wifi":true,"lfr":true,"bandwidth":true,"battery_dead":true,"local_storage":true}}
    async getAccountNotifications(accountID = 0) {
        await this.login();
        return await this.get(`/api/v1/accounts/${accountID || this.accountID}/notifications/configuration`);
    }

    // {
    //   "account": {
    //     "id": 22156,
    //     "email_verified": true,
    //     "email_verification_required": true
    //   },
    //   "networks": [
    //     {
    //       "id": 22022,
    //       "created_at": "2016-02-13T19:15:54+00:00",
    //       "updated_at": "2020-10-02T00:29:30+00:00",
    //       "name": "82 Downing",
    //       "time_zone": "America/Toronto",
    //       "dst": true,
    //       "armed": false,
    //       "lv_save": false
    //     }
    //   ],
    //   "sync_modules": [
    //     {
    //       "id": 10192,
    //       "created_at": "2016-02-13T19:17:57+00:00",
    //       "updated_at": "2020-10-03T04:35:46+00:00",
    //       "onboarded": true,
    //       "status": "online",
    //       "name": "Blink SM",
    //       "serial": "240007287",
    //       "fw_version": "2.13.26",
    //       "type": "sm1",
    //       "last_hb": "2020-10-03T15:44:36+00:00",
    //       "wifi_strength": 1,
    //       "network_id": 22022,
    //       "enable_temp_alerts": true,
    //       "local_storage_enabled": false,
    //       "local_storage_compatible": false,
    //       "local_storage_status": "unavailable"
    //     }
    //   ],
    //   "cameras": [
    //     {
    //       "id": 136989,
    //       "created_at": "2016-02-13T19:21:09+00:00",
    //       "updated_at": "2020-10-03T14:50:36+00:00",
    //       "name": "Alpha",
    //       "serial": "120040563",
    //       "fw_version": "2.151",
    //       "type": "white",
    //       "enabled": true,
    //       "thumbnail": "/media/production/account/22156/network/22022/camera/136989/clip_HIwRgo6g_2020_10_02__00_28AM",
    //       "status": "done",
    //       "battery": "ok",
    //       "usage_rate": false,
    //       "network_id": 22022,
    //       "issues": [],
    //       "signals": {
    //         "lfr": 5,
    //         "wifi": 5,
    //         "temp": 78,
    //         "battery": 3
    //       },
    //       "local_storage_enabled": false,
    //       "local_storage_compatible": false
    //     },
    //     {
    //       "id": 13812,
    //       "created_at": "2016-02-13T19:29:36+00:00",
    //       "updated_at": "2020-10-03T11:20:36+00:00",
    //       "name": "Beta",
    //       "serial": "130060596",
    //       "fw_version": "2.151",
    //       "type": "white",
    //       "enabled": true,
    //       "thumbnail": "/media/production/account/22156/network/22022/camera/13812/clip_rHLLGq0U_2020_10_02__00_17AM",
    //       "status": "done",
    //       "battery": "ok",
    //       "usage_rate": false,
    //       "network_id": 22022,
    //       "issues": [],
    //       "signals": {
    //         "lfr": 5,
    //         "wifi": 2,
    //         "temp": 65,
    //         "battery": 3
    //       },
    //       "local_storage_enabled": false,
    //       "local_storage_compatible": false
    //     }
    //   ],
    //   "sirens": [],
    //   "chimes": [],
    //   "video_stats": {
    //     "storage": 1,
    //     "auto_delete_days": 365,
    //     "auto_delete_day_options": [
    //       3,
    //       7,
    //       14,
    //       30,
    //       365
    //     ]
    //   },
    //   "doorbell_buttons": [],
    //   "owls": [],
    //   "app_updates": {
    //     "message": "OK",
    //     "code": 103,
    //     "update_available": false,
    //     "update_required": false
    //   },
    //   "device_limits": {
    //     "camera": 10,
    //     "chime": 5,
    //     "doorbell_button": 2,
    //     "owl": 10,
    //     "siren": 5,
    //     "total_devices": 20
    //   },
    //   "whats_new": {
    //     "updated_at": 20200902,
    //     "url": "https://updates.blinkforhome.com/"
    //   }
    // }
    async getAccountHomescreen(maxTTL = 30, accountID = 0) {
        // let a = {"account":{"id":12158,"email_verified":true,"email_verification_required":true},"networks":[{"id":12092,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2020-10-09T22:38:33+00:00","name":"Kingston Ave","time_zone":"America/Toronto","dst":true,"armed":false,"lv_save":false}],"sync_modules":[{"id":10192,"created_at":"2016-02-13T19:17:57+00:00","updated_at":"2020-10-09T23:26:38+00:00","onboarded":true,"status":"offline","name":"Blink SM","serial":"240007287","fw_version":"2.13.26","type":"sm1","last_hb":"2020-10-09T23:25:30+00:00","wifi_strength":3,"network_id":12092,"enable_temp_alerts":true,"local_storage_enabled":false,"local_storage_compatible":false,"local_storage_status":"unavailable"}],"cameras":[{"id":36799,"created_at":"2016-02-13T19:21:09+00:00","updated_at":"2020-10-09T22:38:35+00:00","name":"Alpha","serial":"160060593","fw_version":"2.151","type":"white","enabled":true,"thumbnail":"/media/production/account/12158/network/12092/camera/36799/clip_iyIKCUKb_2020_10_09__22_36PM","status":"done","battery":"ok","usage_rate":false,"network_id":12092,"issues":[],"signals":{"lfr":5,"wifi":3,"temp":72,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false},{"id":36817,"created_at":"2016-02-13T19:29:36+00:00","updated_at":"2020-10-09T23:10:31+00:00","name":"Beta","serial":"130060596","fw_version":"2.151","type":"white","enabled":true,"thumbnail":"/media/production/account/12158/network/12092/camera/36817/clip_rHLLGq0U_2020_10_02__00_17AM","status":"done","battery":"ok","usage_rate":false,"network_id":12092,"issues":[],"signals":{"lfr":5,"wifi":5,"temp":72,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false}],"sirens":[],"chimes":[],"video_stats":{"storage":5,"auto_delete_days":365,"auto_delete_day_options":[3,7,14,30,365]},"doorbell_buttons":[],"owls":[],"app_updates":{"message":"OK","code":103,"update_available":false,"update_required":false},"device_limits":{"camera":10,"chime":5,"doorbell_button":2,"owl":10,"siren":5,"total_devices":20},"whats_new":{"updated_at":20200902,"url":"https://updates.blinkforhome.com/"}}

        await this.login();
        return await this.get(`/api/v3/accounts/${accountID || this.accountID}/homescreen`, null,  maxTTL);
    }

    async updateAccountPassword(changePasswordBody) {
        await this.login();
        return await this.post(`/account/change_password/`, changePasswordBody);
    }

    // {"id":12147,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2019-01-06T17:03:28+00:00","email":"user@example.com","verified":true,"verification_required":true,"force_password_reset":false,"reset_expiration":null,"time_zone":"US/Eastern","owner":true,"name":"","user_access":"write","temp_units":"f","type":"regular","pin_created_at":null,"pin_failures":0,"account_id":22156}
    async getUser() {
        await this.login();
        return await this.get(`/user`);
    }

    // {"options":"{}"}
    async getCientOptions(accountID = 0, clientID = 0) {
        await this.login();
        return await this.get(`/api/v1/accounts/${accountID || this.accountID}/clients/${clientID || this.clientID}/options`);
    }

    // async deleteAccount(deleteAccountBody) {
    //     return await this.post(`/account/delete/`, deleteAccountBody);
    // }

    async logoutClient(accountID = 0, clientID = 0) {
        await this.login();
        return await this.post(`/api/v4/account/${accountID || this.accountID}/client/${clientID || this.clientID}/logout/`);
    }

    async createAccount(registerAccount) {
        await this.login();
        return await this.post(`/api/v4/account/register`, registerAccount);
    }

    async resetPassword(resetPasswordBody) {
        await this.login();
        return await this.post(`/account/reset_password/`, resetPasswordBody);
    }

    async updateClientOptions(clientOptionsResponse, accountID = 0, clientID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/clients/${clientID || this.clientID}/options`, clientOptionsResponse);
    }

    async updateAccount(updateAccountBody) {
        await this.login();
        return await this.post(`/account/update`, updateAccountBody);
    }

    // {"account":{"id":22156,"verification_required":false},"client":{"id":3267394,"verification_required":false}}
    async getAccountStatus(accountID = 0) {
        await this.login();
        return await this.get(`/api/v3/account/${accountID || this.accountID}/status`);
    }

    async updateVideoOptions(autoPurgeSetterBody) {
        await this.login();
        return await this.post(`/api/v1/account/video_options`, autoPurgeSetterBody);
    }

    // Media

    // {
    //   "limit": 25,
    //   "purge_id": 2139143115,
    //   "refresh_count": 0,
    //   "media": [
    //     {
    //       "id": 2139143346,
    //       "created_at": "2020-10-02T00:28:38+00:00",
    //       "updated_at": "2020-10-02T00:28:57+00:00",
    //       "deleted": false,
    //       "device": "camera",
    //       "device_id": 13812,
    //       "device_name": "Beta",
    //       "network_id": 22022,
    //       "network_name": "82 Downing",
    //       "type": "video",
    //       "source": "pir",
    //       "watched": false,
    //       "partial": false,
    //       "thumbnail": "/api/v2/accounts/22156/media/thumb/2139143346",
    //       "media": "/api/v2/accounts/22156/media/clip/2139143346.mp4",
    //       "additional_devices": [],
    //       "time_zone": "America/Tortola"
    //     }
    //   ]
    // }
    async getMediaChange(after = "1970-01-01T00:00:01+0000", page = 1, accountID = 0) {
        await this.login();
        return await this.get(`/api/v1/accounts/${accountID || this.accountID}/media/changed?since=1970-01-01T00:00:01+0000&page=1`);
    }

    async deleteMedia(medialist = [], accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/media/delete`, {media_list: medialist});
    }

    // Command
    async getCommand(networkID, commandID) {
        await this.login();
        return await this.get(`/network/${networkID}/command/${commandID}`);
    }

    async updateCommand(networkID, commandID, updateCommandRequest) {
        await this.login();
        return await this.post(`/network/${networkID}/command/${commandID}/update/`, updateCommandRequest);
    }

    async deleteCommand(networkID, commandID) {
        await this.login();
        return await this.post(`/network/${networkID}/command/${commandID}/done/`);
    }

    // Programs
    async getPrograms(networkID) {
        await this.login();
        return await this.get(`/api/v1/networks/${networkID}/programs`);
    }

    // {
    //     "format": "v1",
    //     "id": 105008,
    //     "name": "Schedule for 82 Downing",
    //     "schedule": [
    //         {
    //             "action": "arm",
    //             "devices": [],
    //             "dow": [
    //                 "sun",
    //                 "wed"
    //             ],
    //             "time": "2020-10-03 04:00:00 +0000"
    //         },
    //         {
    //             "action": "disarm",
    //             "devices": [],
    //             "dow": [
    //                 "sun",
    //                 "wed"
    //             ],
    //             "time": "2020-10-03 05:30:00 +0000"
    //         }
    //     ]
    // }
    async createProgram(networkID, program) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/programs/create`, program);
    }

    async deleteProgram(networkID, prgoramID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/programs/${prgoramID}/delete`);
    }

    async disableProgram(networkID, programID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/programs/${programID}/disable`);
    }

    async enableProgram(networkID, programID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/programs/${programID}/enable`);
    }

    async updateProgram(networkID, programID, updateProgramRequest) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/programs/${programID}/update`, updateProgramRequest);
    }

    // Camera

    // {
    //   "camera": [
    //     {
    //       "id": 136989,
    //       "created_at": "2016-02-13T19:21:09+00:00",
    //       "updated_at": "2020-10-03T14:50:36+00:00",
    //       "deleted_at": null,
    //       "serial": "120040563",
    //       "camera_key": "",
    //       "fw_version": "2.151",
    //       "mac_address": null,
    //       "ip_address": null,
    //       "thumbnail": "/media/production/account/22156/network/22022/camera/136989/clip_HIwRgo6g_2020_10_02__00_28AM",
    //       "name": "Alpha",
    //       "liveview_enabled": "off",
    //       "siren_enable": false,
    //       "siren_volume": null,
    //       "onboarded": true,
    //       "unit_number": 1,
    //       "motion_sensitivity": 5,
    //       "enabled": true,
    //       "alert_tone_enable": true,
    //       "alert_tone_volume": 0,
    //       "alert_repeat": "off",
    //       "alert_interval": 10,
    //       "video_length": 30,
    //       "temp_alarm_enable": true,
    //       "temp_interval": 1,
    //       "temp_adjust": 8,
    //       "temp_min": 50,
    //       "temp_max": 88,
    //       "temp_hysteresis": null,
    //       "illuminator_enable": 0,
    //       "illuminator_duration": 1,
    //       "illuminator_intensity": 7,
    //       "battery_alarm_enable": false,
    //       "battery_voltage_interval": 0,
    //       "battery_voltage_threshold": 512,
    //       "battery_voltage_hysteresis": 512,
    //       "last_battery_alert": null,
    //       "battery_alert_count": 0,
    //       "lfr_sync_interval": 8,
    //       "video_50_60hz": "freq_60hz",
    //       "invert_image": false,
    //       "flip_image": false,
    //       "record_audio_enable": true,
    //       "clip_rate": 4,
    //       "liveview_rate": 9,
    //       "max_resolution": "r720",
    //       "auto_test": false,
    //       "wifi_timeout": 30,
    //       "retry_count": 0,
    //       "status": "done",
    //       "wifi_strength": -50,
    //       "lfr_strength": -63,
    //       "temperature": 70,
    //       "battery_voltage": 159,
    //       "a1": false,
    //       "last_temp_alert": null,
    //       "temp_alert_count": 0,
    //       "last_wifi_alert": null,
    //       "wifi_alert_count": 0,
    //       "last_lfr_alert": null,
    //       "lfr_alert_count": 0,
    //       "last_offline_alert": "2020-09-17T04:41:44+00:00",
    //       "offline_alert_count": 3,
    //       "temp_alert_state": "in_range",
    //       "battery_state": "ok",
    //       "battery_check_time": "2020-10-03T14:50:36+00:00",
    //       "last_snapshot_event": null,
    //       "motion_regions": 33554431,
    //       "mfg_main_type": "MA",
    //       "mfg_main_range": 1601016399,
    //       "mfg_mez_type": "",
    //       "mfg_mez_range": 0,
    //       "type": "white",
    //       "account_id": 22156,
    //       "network_id": 22022,
    //       "sync_module_id": 10192,
    //       "account": 22156,
    //       "network": 22022,
    //       "camera_seq": 1,
    //       "last_connect": {
    //         "camera_id": 136989,
    //         "created_at": "2017-10-31T22:12:59+00:00",
    //         "updated_at": "2020-10-03T04:36:23+00:00",
    //         "wifi_strength": -55,
    //         "lfr_strength": -58,
    //         "battery_voltage": 159,
    //         "temperature": 73,
    //         "fw_version": "2.151",
    //         "fw_git_hash": null,
    //         "mac": "f4:b8:5e:8a:54:b1",
    //         "ipv": "ipv4",
    //         "ip_address": "10.0.0.144",
    //         "error_codes": 0,
    //         "battery_alert_status": false,
    //         "temp_alert_status": false,
    //         "ac_power": false,
    //         "light_sensor_ch0": 0,
    //         "light_sensor_ch1": 159,
    //         "light_sensor_data_valid": false,
    //         "light_sensor_data_new": false,
    //         "time_first_video": 0,
    //         "time_108_boot": 89281,
    //         "time_wlan_connect": 1187793,
    //         "time_dhcp_lease": 4495321,
    //         "time_dns_resolve": 0,
    //         "lfr_108_wakeups": 1,
    //         "total_108_wakeups": 2,
    //         "lfr_tb_wakeups": 1,
    //         "total_tb_wakeups": 4354,
    //         "wifi_connect_failure_count": 0,
    //         "dhcp_failure_count": 0,
    //         "socket_failure_count": 0,
    //         "dev_1": 4498846,
    //         "dev_2": 27136,
    //         "dev_3": 120040563,
    //         "unit_number": 1,
    //         "serial": "120040563",
    //         "lifetime_count": 0,
    //         "lifetime_duration": 0,
    //         "pir_rejections": 0,
    //         "sync_module_id": 10192,
    //         "network_id": 22022,
    //         "account_id": 22156
    //       },
    //       "motion_alert": true,
    //       "record_audio": true,
    //       "buzzer_on": true,
    //       "early_termination": true,
    //       "clip_bitrate": 4,
    //       "liveview_bitrate": 9,
    //       "motion_regions_compatible": true,
    //       "early_pir_compatible": false,
    //       "early_notification_compatible": false,
    //       "night_vision_exposure_compatible": false,
    //       "privacy_zones_compatible": false,
    //       "video_quality_support": [
    //         "saver",
    //         "standard"
    //       ],
    //       "video_quality": "standard",
    //       "early_notification": false,
    //       "night_vision_exposure": 1,
    //       "local_storage_enabled": false,
    //       "local_storage_compatible": false,
    //       "clip_max_length": 60,
    //       "early_termination_supported": true,
    //       "clip_warning_threshold": 15,
    //       "flip_video_compatible": false,
    //       "flip_video": false,
    //       "video_recording_enable": true,
    //       "video_recording_optional": false,
    //       "snapshot_compatible": false,
    //       "snapshot_enabled": false,
    //       "snapshot_period_minutes_options": [
    //         60
    //       ],
    //       "snapshot_period_minutes": 60
    //     }
    //   ],
    //   "signals": {
    //     "lfr": 5,
    //     "wifi": 4,
    //     "updated_at": "2020-10-03T04:36:23+00:00",
    //     "temp": 78,
    //     "battery": 3,
    //     "battery_state": "ok"
    //   }
    // }
    async getCameraConfig(networkID, cameraID) {
        await this.login();
        return await this.get(`/network/${networkID}/camera/${cameraID}/config`);
    }

    // {
    //     "range_days": 7,
    //     "reference": {"usage": 400},
    //     "networks": [{
    //         "network_id": 22022,
    //         "name": "82 Downing",
    //         "cameras": [{
    //             "id": 136989,
    //             "name": "Alpha",
    //             "usage": 13,
    //             "lv_seconds": 9,
    //             "clip_seconds": 4
    //         }, {"id": 13812, "name": "Beta", "usage": 54, "lv_seconds": 10, "clip_seconds": 44}]
    //     }]
    // }
    async getCameraUsage() {
        await this.login();
        return await this.get(`/api/v1/camera/usage`);
    }

    async acknowledgeNotification(notifications = {}) {
        await this.login();
        return await this.post(`/api/v2/notification`, notifications);
    }
// {
//     "camera_status": {
//         "camera_id": 136989,
//         "created_at": "2017-10-31T22:12:59+00:00",
//         "updated_at": "2020-10-03T04:36:23+00:00",
//         "wifi_strength": -55,
//         "lfr_strength": -58,
//         "battery_voltage": 159,
//         "temperature": 73,
//         "fw_version": "2.151",
//         "fw_git_hash": null,
//         "mac": "f4:b8:5e:8a:54:b1",
//         "ipv": "ipv4",
//         "ip_address": "10.0.0.144",
//         "error_codes": 0,
//         "battery_alert_status": false,
//         "temp_alert_status": false,
//         "ac_power": false,
//         "light_sensor_ch0": 0,
//         "light_sensor_ch1": 159,
//         "light_sensor_data_valid": false,
//         "light_sensor_data_new": false,
//         "time_first_video": 0,
//         "time_108_boot": 89281,
//         "time_wlan_connect": 1187793,
//         "time_dhcp_lease": 4495321,
//         "time_dns_resolve": 0,
//         "lfr_108_wakeups": 1,
//         "total_108_wakeups": 2,
//         "lfr_tb_wakeups": 1,
//         "total_tb_wakeups": 4354,
//         "wifi_connect_failure_count": 0,
//         "dhcp_failure_count": 0,
//         "socket_failure_count": 0,
//         "dev_1": 4498846,
//         "dev_2": 27136,
//         "dev_3": 120040563,
//         "unit_number": 1,
//         "serial": "120040563",
//         "lifetime_count": 0,
//         "lifetime_duration": 0,
//         "pir_rejections": 0,
//         "sync_module_id": 10192,
//         "network_id": 22022,
//         "account_id": 22156,
//         "id": 1,
//         "thumbnail": "/media/production/account/22156/network/22022/camera/136989/clip_HIwRgo6g_2020_10_02__00_28AM"
//     }
// }
    async getCameraStatus(networkID, cameraID, maxTTL = 60*60) {
        await this.login();
        return await this.get(`/network/${networkID}/camera/${cameraID}`, null, maxTTL);
    }

    async updateCameraThumbnail(networkID, cameraID) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/thumbnail`);
    }

    async updateCameraMotion(networkID, cameraID, type = "clip") {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/${type}`);
    }

    async enableCameraMotion(networkID, cameraID) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/enable`);
    }

    async disableCameraMotion(networkID, cameraID) {
        return await this.post(`/network/${networkID}/camera/${cameraID}/disable`);
    }

    async createCamera(networkID, addCameraBody) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/add`, addCameraBody);
    }

    async deleteCamera(networkID, cameraID) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/delete/`);
    }

    async getCameraMotionRegions(networkID, cameraID, accountID = 0) {
        await this.login();
        return await this.get(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/cameras/${cameraID}/motion_regions`);
    }

    // async getCameraLiveView(networkID, cameraID, videoLiveViewBody) {
    //    await this.login();
    //    return await this.post(`/api/v3/networks/${networkID}/cameras/${cameraID}/liveview`, videoLiveViewBody);
    // }

    async getCameraLiveViewV5(networkID, cameraID, accountID = 0) {
        await this.login();
        const data = {
            "intent": "liveview",
            "motion_event_start_time": ""
        }
        return await this.post(`/api/v5/accounts/${accountID || this.accountID}/networks/${networkID}/cameras/${cameraID}/liveview`, data);
    }

    async updateCameraStatus(networkID, cameraID) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/status`);
    }

    async updateCameraTemperature(networkID, cameraID, currentTempF, minTempF, maxTempF) {
        await this.login();
        const body = {
            "temp_max": maxTempF,
            "id": cameraID,
            "current_temp": currentTempF,
            "temp_min": minTempF,
            "network": networkID
        }
        return await this.post(`/api/v1/network/${networkID}/camera/${cameraID}/calibrate`, body);
    }

    async updateCameraSettings(networkID, cameraID, updateCameraBody) {
        await this.login();
        return await this.post(`/network/${networkID}/camera/${cameraID}/update`, updateCameraBody);
    }

    async updateCameraMotionRegions(networkID, cameraID, motionRegions, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/cameras/${cameraID}/motion_regions`, motionRegions);
    }

    async disableCameraTempAlert(networkID, cameraID) {
        await this.login();
        return await this.post(`/api/v1/network/${networkID}/camera/${cameraID}/temp_alert_disable`);
    }

    async enableCameraTempAlert(networkID, cameraID) {
        await this.login();
        return await this.post(`/api/v1/network/${networkID}/camera/${cameraID}/temp_alert_enable`);
    }

    // {"lfr":5,"wifi":5,"updated_at":"2020-10-03T14:50:36+00:00","temp":78,"battery":3}
    async getCameraSignals(networkID, cameraID) {
        await this.login();
        return await this.get(`/network/${networkID}/camera/${cameraID}/signals`);
    }

    // Siren
    async getSirens() {
        await this.login();
        return await this.get(`/sirens`);
    }

    async getNetworkSirens(networkID) {
        await this.login();
        return await this.get(`/api/v1/networks/${networkID}/sirens/`);
    }

    async activateSiren(networkID, sirenID, duration = 0) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/${sirenID}/activate/`, {duration});
    }

    async activateSirens(networkID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/activate/`, {duration});
    }

    async createSiren(networkID, addSirenNetworkBody) {
        this.post(`/api/v1/networks/${networkID}/sirens/add/`, addSirenNetworkBody);
    }

    async deactivateSirens(networkID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/deactivate/`);
    }

    async deleteSirens(networkID, sirenID) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/${sirenID}/delete`);
    }

    async updateSiren(networkID, sirenID, sirenNameBody) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/${sirenID}/update`, sirenNameBody);
    }

    async updateSirens(networkID, sirenDurationBody) {
        await this.login();
        return await this.post(`/api/v1/networks/${networkID}/sirens/update`, sirenDurationBody);
    }

    //Chime
    async createChime(networkID, addSirenNetworkBody, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/chimes/add/`, addSirenNetworkBody);
    }

    // Owl
    async getOwlConfig(networkID, owlID, accountID = 0) {
        await this.login();
        return await this.get(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkId}/owls/${owlID}/config`);
    }

    async getCameraLiveViewOwl(networkID, owlID, liveViewBody, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/liveview`, liveViewBody);
    }

    async updateOwlStatus(networkID, owlID, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/status`);
    }

    async updateOwlSettings(owlID, updateOwlBody, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/config`, updateOwlBody);
    }

    async updateOwlThumbnail(networkID, owlID, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/thumbnail`);
    }

    async createOwl(networkID, addOwlBody, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/add`, addOwlBody);
    }

    async changeOwlWifi(networkID, owlID, onboardingStartRequest, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/change_wifi`, onboardingStartRequest);
    }

    async deleteOwl(networkID, owlID, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/${owlID}/delete`);
    }

    async addOwl(networkID, onboardingStartRequest, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/owls/add`, onboardingStartRequest);
    }

    //Network
    // {"summary":{"22022":{"name":"82 Downing","onboarded":true}},"networks":[{"id":22022,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2020-10-02T00:29:30+00:00","name":"82 Downing","network_key":"hifSnlicp+k4bLA=","description":"","network_origin":"normal","locale":"","time_zone":"America/Toronto","dst":true,"ping_interval":60,"encryption_key":null,"armed":false,"autoarm_geo_enable":false,"autoarm_time_enable":false,"lv_mode":"relay","lfr_channel":0,"video_destination":"server","storage_used":0,"storage_total":0,"video_count":0,"video_history_count":4000,"sm_backup_enabled":false,"arm_string":"Disarmed","busy":false,"camera_error":false,"sync_module_error":false,"feature_plan_id":null,"account_id":22156}]}
    async getNetworks() {
        await this.login();
        return await this.get(`/networks`);
    }

    // {"id":750082190,"network_id":22022,"command":"arm","state":"new","commands":[{"id":750082191,"network_id":22022,"command":"config_lfr","state":"running"},{"id":750082192,"network_id":22022,"command":"config_lfr","state":"running"}]}
    async armNetwork(networkID, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/state/arm`);
    }


    // {"id":750082372,"network_id":22022,"command":"disarm","state":"new","commands":[{"id":750082373,"network_id":22022,"command":"config_lfr","state":"running"},{"id":750082374,"network_id":22022,"command":"config_lfr","state":"running"}]}
    async disarmNetwork(networkID, accountID = 0) {
        await this.login();
        return await this.post(`/api/v1/accounts/${accountID || this.accountID}/networks/${networkID}/state/disarm`);
    }

    async createNetwork(addNetworkBody) {
        await this.login();
        return await this.post(`/network/add`, addNetworkBody);
    }

    async deleteNetwork(networkID) {
        await this.login();
        return await this.post(`/network/${networkID}/delete`);
    }

    //{"dst":true,"lv_mode":"relay","time_zone":"America\/Toronto"}
    async updateNetwork(updateNetworkSaveAllLiveViews) {
        await this.login();
        return await this.post(`/network/${networkID}/update`, updateNetworkSaveAllLiveViews);
    }

    async getDevice(serialNumber) {
        await this.login();
        return await this.get(`/api/v1/devices/identify/${serialNumber}`);
    }

    async addSyncModuleDevice(networkID, type, onboardingStartRequest) {
        await this.login();
        return await this.post(`/api/v2/network/${networkID}/sync_module/${type}`);
    }

    async deleteSyncModule(networkID, syncModuleID) {
        await this.login();
        return await this.post(`/network/${networkID}/syncmodule/${syncModuleID}/delete/`);
    }


    async getUrl(url) {
        await this.login();
        return await this.get(`${url}`);
    }

    // async getSyncModuleFirmware(serial) {
    //     await this.login();
    //     return await this.get(`/api/v1/sync_modules/${serial}/fw_update`);
    // }
    //
    // async getOwlFirmware(serial, accountID = 0) {
    //     await this.login();
    //     return await this.get(`/api/v1/accounts/${accountID || this.accountID}/owls/${serial}/fw_update`);
    // }
    async getAppStatus(serial) {
        await this.login();
        return await this.get(`/api/v1/fw/app/update_check?serial=${serial}`);
    }


    async updateSystem(networkID, updateSystemNameBody) {
        await this.login();
        return await this.post(`/network/${networkID}/update`, updateSystemNameBody);
    }

    async updateTimezone(networkID, updateTimezoneBody) {
        await this.login();
        return await this.post(`/network/${networkID}/update`, updateTimezoneBody);
    }


// POST             rest-prod.immedia-semi.com /api/v1/accounts/22156/networks/22022/state/disarm
// POST             rest-prod.immedia-semi.com /api/v1/accounts/22156/notifications/configuration
// POST             rest-prod.immedia-semi.com /api/v1/network/22022/camera/136989/calibrate
// POST             rest-prod.immedia-semi.com /api/v4/account/22156/client/2360401/logout
// POST             rest-prod.immedia-semi.com /api/v5/accounts/22156/networks/22022/cameras/136989/liveview
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/status
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/thumbnail
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/update
// POST             rest-prod.immedia-semi.com /network/22022/update
// POST https://rest-prod.immedia-semi.com/api/v1/accounts/22156/networks/22022/state/arm


}

module.exports = BlinkAPI;


// POST https://rest-prod.immedia-semi.com/api/v4/account/login
//
// :authority:       rest-prod.immedia-semi.com
// locale:           en_CA
// content-type:     application/json
// accept:           */*
// app-build:        IOS_8854
// accept-encoding:  gzip, deflate, br
// user-agent:       Blink/8854 CFNetwork/1202 Darwin/20.1.0
// accept-language:  en-CA
// content-length:   337
//
// {
//     "app_version": "6.1.1 (8854) #e06341d7f",
//     "client_name": "iPhone",
//     "client_type": "ios",
//     "device_identifier": "iPhone12,3",
//     "email": "user@example.com",
//     "notification_key": "4976d0584130d0122a31887952f778aab5164461fe43db067159dc11da2cb535",
//     "os_version": "14.2",
//     "password": "password1",
//     "unique_id": "6D684F3D-1D86-14F9-B748-15571A3F1FFF"
// }
//
// content-type:            application/json
// date:                    Fri, 02 Oct 2020 00:26:27 GMT
// vary:                    Accept-Encoding
// status:                  200 OK
// x-blink-served-by:       i-022a33c1836242ee4
// x-content-type-options:  nosniff
// x-powered-by:            Phusion Passenger
// server:                  nginx + Phusion Passenger
// content-encoding:        gzip
// x-cache:                 Miss from cloudfront
// via:                     1.1 2c060d2b820e53bf308fe03fbfaed0e9.cloudfront.net (CloudFront)
// x-amz-cf-pop:            ATL56-C1
// x-amz-cf-id:             9gCCfKQ9_aGv53o0Gt75aNVRs0bxiWtkQ_FC-kWYJYLEeihFtm9BAw==
// [decoded gzip] JSON                                                                                                                                                                                                                                   [m:auto]
// {
//     "accountID": {
//         "id": 22156,
//         "new_account": false,
//         "verification_required": false
//     },
//     "allow_pin_resend_seconds": 60,
//     "authtoken": {
//         "authtoken": "2YKEsy9BPb9puha1s4uBwe",
//         "message": "auth"
//     },
//     "client": {
//         "id": 2360401,
//         "verification_required": true
//     },
//     "force_password_reset": false,
//     "lockout_time_remaining": 0,
//     "region": {
//         "code": "us",
//         "description": "United States",
//         "tier": "prod"
//     }
// }
//

// POST https://rest-prod.immedia-semi.com/api/v4/account/22156/client/2360401/pin/verify
// :authority:       rest-prod.immedia-semi.com
// locale:           en_CA
// content-type:     application/json
// accept:           */*
// app-build:        IOS_8854
// token-auth:       2YKEsy9BPb9puha1s4uBwe
// accept-encoding:  gzip, deflate, br
// user-agent:       Blink/8854 CFNetwork/1202 Darwin/20.1.0
// accept-language:  en-CA
// content-length:   16
// {"pin":"123456"}

// content-type:            application/json
// date:                    Fri, 02 Oct 2020 00:26:48 GMT
// vary:                    Accept-Encoding
// status:                  200 OK
// x-blink-served-by:       i-084c7f99a490e5cf5
// x-content-type-options:  nosniff
// x-powered-by:            Phusion Passenger
// server:                  nginx + Phusion Passenger
// content-encoding:        gzip
// x-cache:                 Miss from cloudfront
// via:                     1.1 2c060d2b820e53bf308fe03fbfaed0e9.cloudfront.net (CloudFront)
// x-amz-cf-pop:            ATL56-C1
// x-amz-cf-id:             lbxn02VW0vtzs3S0QnPnkjdnW5rTyja2ooPMSbQAI3jQjal2O-ynfQ==
// {
//     "code": 1626,
//     "message": "Client has been successfully verified",
//     "require_new_pin": false,
//     "valid": true
// }

// GET https://rest-prod.immedia-semi.com/api/v1/accounts/22156/clients/2360401/options
// {
//     "options": "eyJuZXR3b3JrX29yZGVyIjpbMTIwOTJdLCJrZXlzIjpbWyJjbGllbnQub3B0aW9ucy5zaG93X2hvbWVzY3JlZW5fdHV0b3JpYWxfc3RhdGUiLCJOMSJdLFsiaG9tZXNjcmVlbi53aGF0c19uZXdfbGFzdF9zaG93ZWRfYXQiLCJOMjAyMDA5MDIiXSxbImNsaWVudC5vcHRpb25zLnNob3dfYWRkX2RldmljZV90dXRvcm
//     lhbF9zdGF0ZSIsIk4xIl1dLCJzY2hlbWEiOjEsImNhbWVyYV9vcmRlciI6eyIxMjA5MiI6WzM2Nzk5LDM2ODE3XX19"
// }

// base64 decode:
//
// {
//     "network_order":    [22022],
//     "keys":    [
//         ["client.options.show_homescreen_tutorial_state", "N1"],
//         ["homescreen.whats_new_last_showed_at", "N20200902"],
//         ["client.options.show_add_device_tutorial_state", "N1"]
//     ],
//     "schema": 1,
//     "camera_order": {
//         "22022" : [136989, 13812]
//     }
// }


// GET https://rest-prod.immedia-semi.com/api/v1/accounts/22156/media/changed?since=1970-01-01T00:00:00+0000&page=1
// {
//     "limit": 25,
//     "media": [],
//     "purge_id": 2139129532,
//     "refresh_count": 0
// }

// GET https://rest-prod.immedia-semi.com/api/v3/accounts/22156/homescreen
//${"accountID":{"id":22156,"email_verified":true,"email_verification_required":true},"networks":[{"id":22022,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2020-10-02T00:18:59+00:00","name":"82 Downing","time_zone":"America/Tortola","dst":true,"armed":false,"lv_save":false}],"sync_modules":[{"id":10192,"created_at":"2016-02-13T19:17:57+00:00","updated_at":"2020-10-02T00:04:40+00:00","onboarded":true,"status":"online","name":"Blink SM","serial":"240007287","fw_version":"2.13.26","type":"sm1","last_hb":"2020-10-02T00:26:25+00:00","wifi_strength":1,"network_id":22022,"enable_temp_alerts":true,"local_storage_enabled":false,"local_storage_compatible":false,"local_storage_status":"unavailable"}],"cameras":[{"id":136989,"created_at":"2016-02-13T19:21:09+00:00","updated_at":"2020-10-02T00:17:18+00:00","name":"Alpha","serial":"120040563","fw_version":"2.151","type":"white","enabled":true,"thumbnail":"/media/production/account/22156/network/22022/camera/136989/clip_3_UEAZ8Q_2019_01_06__20_48PM","status":"done","battery":"ok","usage_rate":false,"network_id":22022,"issues":[],"signals":{"lfr":5,"wifi":5,"temp":73,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false},{"id":13812,"created_at":"2016-02-13T19:29:36+00:00","updated_at":"2020-10-02T00:19:31+00:00","name":"Beta","serial":"130060596","fw_version":"2.151","type":"white","enabled":true,"thumbnail":"/media/production/account/22156/network/22022/camera/13812/clip_rHLLGq0U_2020_10_02__00_17AM","status":"done","battery":"ok","usage_rate":false,"network_id":22022,"issues":[],"signals":{"lfr":5,"wifi":5,"temp":72,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false}],"sirens":[],"chimes":[],"video_stats":{"storage":0,"auto_delete_days":365,"auto_delete_day_options":[3,7,14,30,365]},"doorbell_buttons":[],"owls":[],"app_updates":{"message":"OK","code":103,"update_available":false,"update_required":false},"device_limits":{"camera":10,"chime":5,"doorbell_button":2,"owl":10,"siren":5,"total_devices":20},"whats_new":{"updated_at":20200902,"url":"https://updates.blinkforhome.com/"}}

//GET              rest-prod.immedia-semi.com /api/v1/account/options
//${"catalina_app_enabled":true,"sm2_app_enabled":true,"snapshot_app_enabled":true,"owl_app_enabled":true,"legacy_account_mini":true}
// GET              rest-prod.immedia-semi.com /api/v1/accounts/22156/notifications/configuration
// {"notifications":{"low_battery":true,"camera_offline":true,"camera_usage":false,"scheduling":true,"motion":true,"sync_module_offline":true,"temperature":true,"doorbell":true,"wifi":true,"lfr":true,"bandwidth":true,"battery_dead":true,"local_storage":true}}
// GET              rest-prod.immedia-semi.com /api/v1/networks/22022/programs
// []

//GET              rest-prod.immedia-semi.com /media/production/account/22156/network/22022/camera/136989/clip_3_UEAZ8Q_2019_01_06__20_48PM.jpg
//GET              rest-prod.immedia-semi.com /media/production/account/22156/network/22022/camera/13812/clip_rHLLGq0U_2020_10_02__00_17AM.jpg
//GET              rest-prod.immedia-semi.com /network/22022/camera/136989/config
//${"camera":[{"id":136989,"created_at":"2016-02-13T19:21:09+00:00","updated_at":"2020-10-02T00:17:18+00:00","deleted_at":null,"serial":"120040563","camera_key":"","fw_version":"2.151","mac_address":null,"ip_address":null,"thumbnail":"/media/production/account/22156/network/22022/camera/136989/clip_3_UEAZ8Q_2019_01_06__20_48PM","name":"Alpha","liveview_enabled":"off","siren_enable":false,"siren_volume":null,"onboarded":true,"unit_number":1,"motion_sensitivity":5.0,"enabled":true,"alert_tone_enable":true,"alert_tone_volume":0,"alert_repeat":"off","alert_interval":10,"video_length":30,"temp_alarm_enable":true,"temp_interval":1,"temp_adjust":7,"temp_min":41,"temp_max":86,"temp_hysteresis":null,"illuminator_enable":0,"illuminator_duration":1,"illuminator_intensity":7,"battery_alarm_enable":false,"battery_voltage_interval":0,"battery_voltage_threshold":512,"battery_voltage_hysteresis":512,"last_battery_alert":null,"battery_alert_count":0,"lfr_sync_interval":8,"video_50_60hz":"freq_60hz","invert_image":false,"flip_image":false,"record_audio_enable":true,"clip_rate":0,"liveview_rate":0,"max_resolution":"r720","auto_test":false,"wifi_timeout":30,"retry_count":0,"status":"done","wifi_strength":-50,"lfr_strength":-54,"temperature":66,"battery_voltage":158,"a1":false,"last_temp_alert":null,"temp_alert_count":0,"last_wifi_alert":null,"wifi_alert_count":0,"last_lfr_alert":null,"lfr_alert_count":0,"last_offline_alert":"2020-09-17T04:41:44+00:00","offline_alert_count":3,"temp_alert_state":"in_range","battery_state":"ok","battery_check_time":"2020-10-02T00:17:18+00:00","last_snapshot_event":null,"motion_regions":33554431,"mfg_main_type":"MA","mfg_main_range":1601016399,"mfg_mez_type":"","mfg_mez_range":0,"type":"white","account_id":22156,"network_id":22022,"sync_module_id":10192,"accountID":22156,"network":22022,"camera_seq":1,"last_connect":{"camera_id":136989,"created_at":"2017-10-31T22:12:59+00:00","updated_at":"2020-10-02T00:16:43+00:00","wifi_strength":-56,"lfr_strength":-59,"battery_voltage":158,"temperature":66,"fw_version":"2.151","fw_git_hash":null,"mac":"f4:b8:5e:8a:54:b1","ipv":"ipv4","ip_address":"10.0.0.144","error_codes":0,"battery_alert_status":false,"temp_alert_status":false,"ac_power":false,"light_sensor_ch0":0,"light_sensor_ch1":158,"light_sensor_data_valid":false,"light_sensor_data_new":false,"time_first_video":0,"time_108_boot":89282,"time_wlan_connect":499063,"time_dhcp_lease":993891,"time_dns_resolve":0,"lfr_108_wakeups":3,"total_108_wakeups":4,"lfr_tb_wakeups":3,"total_tb_wakeups":13060,"wifi_connect_failure_count":0,"dhcp_failure_count":0,"socket_failure_count":0,"dev_1":995895,"dev_2":353,"dev_3":120040563,"unit_number":1,"serial":"120040563","lifetime_count":0,"lifetime_duration":0,"pir_rejections":0,"sync_module_id":10192,"network_id":22022,"account_id":22156},"motion_alert":true,"record_audio":true,"buzzer_on":true,"early_termination":true,"clip_bitrate":0,"liveview_bitrate":0,"motion_regions_compatible":true,"early_pir_compatible":false,"early_notification_compatible":false,"night_vision_exposure_compatible":false,"privacy_zones_compatible":false,"video_quality_support":["saver","standard"],"video_quality":"standard","early_notification":false,"night_vision_exposure":1,"local_storage_enabled":false,"local_storage_compatible":false,"clip_max_length":60,"early_termination_supported":true,"clip_warning_threshold":15,"flip_video_compatible":false,"flip_video":false,"video_recording_enable":true,"video_recording_optional":false,"snapshot_compatible":false,"snapshot_enabled":false,"snapshot_period_minutes_options":[60],"snapshot_period_minutes":60}],"signals":{"lfr":5,"wifi":4,"updated_at":"2020-10-02T00:16:43+00:00","temp":73,"battery":3,"battery_state":"ok"}}

// POST             rest-prod.immedia-semi.com /api/v1/network/22022/camera/136989/calibrate
// {"temp_max":88,"id":136989,"current_temp":73,"temp_min":50,"network":22022}
// {"id":750081889,"created_at":"2020-10-02T00:27:08+00:00","updated_at":"2020-10-02T00:27:08+00:00","execute_time":"2020-10-02T00:27:08+00:00","command":"temp_calibrate","state_stage":"rest","stage_rest":"2020-10-02T00:27:08+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"new","sm_ack":null,"lfr_ack":null,"sequence":null,"attempts":0,"transaction":"sf61Hj9V8FstVDNU","player_transaction":"vwL7YY0xf9-d3Vpq","server":null,"duration":73,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750081889
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081889,"created_at":"2020-10-02T00:27:08+00:00","updated_at":"2020-10-02T00:27:09+00:00","execute_time":"2020-10-02T00:27:08+00:00","command":"temp_calibrate","state_stage":"cs_sent","stage_rest":"2020-10-02T00:27:08+00:00","stage_cs_db":"2020-10-02T00:27:09+00:00","stage_cs_sent":"2020-10-02T00:27:09+00:00","stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":null,"lfr_ack":null,"sequence":360,"attempts":0,"transaction":"sf61Hj9V8FstVDNU","player_transaction":"vwL7YY0xf9-d3Vpq","server":null,"duration":73,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750081889
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081889,"created_at":"2020-10-02T00:27:08+00:00","updated_at":"2020-10-02T00:27:09+00:00","execute_time":"2020-10-02T00:27:08+00:00","command":"temp_calibrate","state_stage":"sm","stage_rest":"2020-10-02T00:27:08+00:00","stage_cs_db":"2020-10-02T00:27:09+00:00","stage_cs_sent":"2020-10-02T00:27:09+00:00","stage_sm":"2020-10-02T00:27:09+00:00","stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":1,"lfr_ack":null,"sequence":360,"attempts":0,"transaction":"sf61Hj9V8FstVDNU","player_transaction":"vwL7YY0xf9-d3Vpq","server":null,"duration":73,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750081889
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081889,"created_at":"2020-10-02T00:27:08+00:00","updated_at":"2020-10-02T00:27:11+00:00","execute_time":"2020-10-02T00:27:08+00:00","command":"temp_calibrate","state_stage":"dev","stage_rest":"2020-10-02T00:27:08+00:00","stage_cs_db":"2020-10-02T00:27:09+00:00","stage_cs_sent":"2020-10-02T00:27:09+00:00","stage_sm":"2020-10-02T00:27:09+00:00","stage_dev":"2020-10-02T00:27:11+00:00","stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":1,"lfr_ack":0,"sequence":360,"attempts":0,"transaction":"sf61Hj9V8FstVDNU","player_transaction":"vwL7YY0xf9-d3Vpq","server":null,"duration":73,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,360,205,147,159,165,0]}","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/update
// {"video_quality":"standard","record_audio_enable":true,"illuminator_enable":0,"video_length":30,"early_termination":true,"name":"Alpha","motion_sensitivity":5,"illuminator_intensity":7,"motion_alert":false,"lfr_sync_interval":8,"alert_interval":10}
// {"id":750081909,"created_at":"2020-10-02T00:27:14+00:00","updated_at":"2020-10-02T00:27:14+00:00","execute_time":"2020-10-02T00:27:14+00:00","command":"config_set","state_stage":"rest","stage_rest":"2020-10-02T00:27:14+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"new","sm_ack":null,"lfr_ack":null,"sequence":null,"attempts":0,"transaction":"iPYvI_VT5Ug4Dovb","player_transaction":"s0O4v8xLXguCLB74","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750081909
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081909,"created_at":"2020-10-02T00:27:14+00:00","updated_at":"2020-10-02T00:27:14+00:00","execute_time":"2020-10-02T00:27:14+00:00","command":"config_set","state_stage":"cs_sent","stage_rest":"2020-10-02T00:27:14+00:00","stage_cs_db":"2020-10-02T00:27:14+00:00","stage_cs_sent":"2020-10-02T00:27:14+00:00","stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":null,"lfr_ack":null,"sequence":361,"attempts":0,"transaction":"iPYvI_VT5Ug4Dovb","player_transaction":"s0O4v8xLXguCLB74","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
// GET              rest-prod.immedia-semi.com /network/22022/command/750081909
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081909,"created_at":"2020-10-02T00:27:14+00:00","updated_at":"2020-10-02T00:27:14+00:00","execute_time":"2020-10-02T00:27:14+00:00","command":"config_set","state_stage":"sm","stage_rest":"2020-10-02T00:27:14+00:00","stage_cs_db":"2020-10-02T00:27:14+00:00","stage_cs_sent":"2020-10-02T00:27:14+00:00","stage_sm":"2020-10-02T00:27:14+00:00","stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":1,"lfr_ack":null,"sequence":361,"attempts":0,"transaction":"iPYvI_VT5Ug4Dovb","player_transaction":"s0O4v8xLXguCLB74","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750081909
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750081909,"created_at":"2020-10-02T00:27:14+00:00","updated_at":"2020-10-02T00:27:17+00:00","execute_time":"2020-10-02T00:27:14+00:00","command":"config_set","state_stage":"is","stage_rest":"2020-10-02T00:27:14+00:00","stage_cs_db":"2020-10-02T00:27:14+00:00","stage_cs_sent":"2020-10-02T00:27:14+00:00","stage_sm":"2020-10-02T00:27:14+00:00","stage_dev":"2020-10-02T00:27:16+00:00","stage_is":"2020-10-02T00:27:17+00:00","stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":1,"lfr_ack":0,"sequence":361,"attempts":0,"transaction":"iPYvI_VT5Ug4Dovb","player_transaction":"s0O4v8xLXguCLB74","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,361,205,123,159,165,0]}","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /api/v3/accounts/22156/homescreen
// {"accountID":{"id":22156,"email_verified":true,"email_verification_required":true},"networks":[{"id":22022,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2020-10-02T00:18:59+00:00","name":"82 Downing","time_zone":"America/Tortola","dst":true,"armed":false,"lv_save":false}],"sync_modules":[{"id":10192,"created_at":"2016-02-13T19:17:57+00:00","updated_at":"2020-10-02T00:04:40+00:00","onboarded":true,"status":"online","name":"Blink SM","serial":"240007287","fw_version":"2.13.26","type":"sm1","last_hb":"2020-10-02T00:26:25+00:00","wifi_strength":1,"network_id":22022,"enable_temp_alerts":true,"local_storage_enabled":false,"local_storage_compatible":false,"local_storage_status":"unavailable"}],"cameras":[{"id":136989,"created_at":"2016-02-13T19:21:09+00:00","updated_at":"2020-10-02T00:27:17+00:00","name":"Alpha","serial":"120040563","fw_version":"2.151","type":"white","enabled":false,"thumbnail":"/media/production/account/22156/network/22022/camera/136989/clip_3_UEAZ8Q_2019_01_06__20_48PM","status":"done","battery":"ok","usage_rate":false,"network_id":22022,"issues":[],"signals":{"lfr":5,"wifi":5,"temp":73,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false},{"id":13812,"created_at":"2016-02-13T19:29:36+00:00","updated_at":"2020-10-02T00:19:31+00:00","name":"Beta","serial":"130060596","fw_version":"2.151","type":"white","enabled":true,"thumbnail":"/media/production/account/22156/network/22022/camera/13812/clip_rHLLGq0U_2020_10_02__00_17AM","status":"done","battery":"ok","usage_rate":false,"network_id":22022,"issues":[],"signals":{"lfr":5,"wifi":5,"temp":72,"battery":3},"local_storage_enabled":false,"local_storage_compatible":false}],"sirens":[],"chimes":[],"video_stats":{"storage":0,"auto_delete_days":365,"auto_delete_day_options":[3,7,14,30,365]},"doorbell_buttons":[],"owls":[],"app_updates":{"message":"OK","code":103,"update_available":false,"update_required":false},"device_limits":{"camera":10,"chime":5,"doorbell_button":2,"owl":10,"siren":5,"total_devices":20},"whats_new":{"updated_at":20200902,"url":"https://updates.blinkforhome.com/"}}
//
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/thumbnail
// {"id":750082005,"created_at":"2020-10-02T00:27:33+00:00","updated_at":"2020-10-02T00:27:33+00:00","execute_time":"2020-10-02T00:27:33+00:00","command":"thumbnail","state_stage":"rest","stage_rest":"2020-10-02T00:27:33+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"new","sm_ack":null,"lfr_ack":null,"sequence":null,"attempts":0,"transaction":"z5fN9ToawFki9Ah_","player_transaction":"iY64wPA2-MUmLct1","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082005
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082005,"created_at":"2020-10-02T00:27:33+00:00","updated_at":"2020-10-02T00:27:33+00:00","execute_time":"2020-10-02T00:27:33+00:00","command":"thumbnail","state_stage":"sm","stage_rest":"2020-10-02T00:27:33+00:00","stage_cs_db":"2020-10-02T00:27:33+00:00","stage_cs_sent":"2020-10-02T00:27:33+00:00","stage_sm":"2020-10-02T00:27:33+00:00","stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":1,"lfr_ack":null,"sequence":363,"attempts":0,"transaction":"z5fN9ToawFki9Ah_","player_transaction":"iY64wPA2-MUmLct1","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082005
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082005,"created_at":"2020-10-02T00:27:33+00:00","updated_at":"2020-10-02T00:27:36+00:00","execute_time":"2020-10-02T00:27:33+00:00","command":"thumbnail","state_stage":"vs","stage_rest":"2020-10-02T00:27:33+00:00","stage_cs_db":"2020-10-02T00:27:33+00:00","stage_cs_sent":"2020-10-02T00:27:33+00:00","stage_sm":"2020-10-02T00:27:33+00:00","stage_dev":"2020-10-02T00:27:35+00:00","stage_is":null,"stage_lv":null,"stage_vs":"2020-10-02T00:27:35+00:00","state_condition":"done","sm_ack":1,"lfr_ack":0,"sequence":363,"attempts":0,"transaction":"z5fN9ToawFki9Ah_","player_transaction":"iY64wPA2-MUmLct1","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,363,205,151,159,165,0]}","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// POST             rest-prod.immedia-semi.com /network/22022/camera/136989/status
// {"id":750082050,"created_at":"2020-10-02T00:27:46+00:00","updated_at":"2020-10-02T00:27:46+00:00","execute_time":"2020-10-02T00:27:46+00:00","command":"status","state_stage":"rest","stage_rest":"2020-10-02T00:27:46+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"new","sm_ack":null,"lfr_ack":null,"sequence":null,"attempts":0,"transaction":"zAvml-R6Q785g6oD","player_transaction":"l7idMspqkC9-cDoE","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":null,"target_id":null,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082050
// GET              rest-prod.immedia-semi.com /network/22022/command/750082050
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082050,"created_at":"2020-10-02T00:27:46+00:00","updated_at":"2020-10-02T00:27:46+00:00","execute_time":"2020-10-02T00:27:46+00:00","command":"status","state_stage":"sm","stage_rest":"2020-10-02T00:27:46+00:00","stage_cs_db":"2020-10-02T00:27:46+00:00","stage_cs_sent":"2020-10-02T00:27:46+00:00","stage_sm":"2020-10-02T00:27:46+00:00","stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"running","sm_ack":1,"lfr_ack":null,"sequence":364,"attempts":0,"transaction":"zAvml-R6Q785g6oD","player_transaction":"l7idMspqkC9-cDoE","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":null,"target_id":null,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082050
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082050,"created_at":"2020-10-02T00:27:46+00:00","updated_at":"2020-10-02T00:27:49+00:00","execute_time":"2020-10-02T00:27:46+00:00","command":"status","state_stage":"is","stage_rest":"2020-10-02T00:27:46+00:00","stage_cs_db":"2020-10-02T00:27:46+00:00","stage_cs_sent":"2020-10-02T00:27:46+00:00","stage_sm":"2020-10-02T00:27:46+00:00","stage_dev":"2020-10-02T00:27:48+00:00","stage_is":"2020-10-02T00:27:49+00:00","stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":1,"lfr_ack":0,"sequence":364,"attempts":0,"transaction":"zAvml-R6Q785g6oD","player_transaction":"l7idMspqkC9-cDoE","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,364,206,151,158,167,0]}","opts_1":0,"target":null,"target_id":null,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// POST             rest-prod.immedia-semi.com /api/v5/accounts/22156/networks/22022/cameras/136989/liveview
// {"intent":"liveview","motion_event_start_time":""}
// {"command_id":750082091,"join_available":true,"join_state":"available","server":"rtsps://lv2-app-prod.immedia-semi.com:443/NIE5Fm36YSJGOOOn__IMDS_120040563?client_id=208&blinkRTSP=true","duration":300,"continue_interval":30,"continue_warning":10,"submit_logs":true,"new_command":true,"media_id":null,"options":{}}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082091
// {"complete":false,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082091,"created_at":"2020-10-02T00:27:54+00:00","updated_at":"2020-10-02T00:27:56+00:00","execute_time":"2020-10-02T00:27:54+00:00","command":"lv_relay","state_stage":"lv","stage_rest":"2020-10-02T00:27:54+00:00","stage_cs_db":"2020-10-02T00:27:54+00:00","stage_cs_sent":"2020-10-02T00:27:54+00:00","stage_sm":"2020-10-02T00:27:54+00:00","stage_dev":"2020-10-02T00:27:56+00:00","stage_is":null,"stage_lv":"2020-10-02T00:27:56+00:00","stage_vs":null,"state_condition":"running","sm_ack":1,"lfr_ack":0,"sequence":365,"attempts":0,"transaction":"NIE5Fm36YSJGOOOn","player_transaction":"mrkXahUbYjfbUgHg","server":"rtsps://lv2-prod.immedia-semi.com:443/NIE5Fm36YSJGOOOn","duration":300,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f - liveview","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,365,205,151,159,167,0]}","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /network/22022/command/750082091
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082091,"created_at":"2020-10-02T00:27:54+00:00","updated_at":"2020-10-02T00:27:56+00:00","execute_time":"2020-10-02T00:27:54+00:00","command":"lv_relay","state_stage":"lv","stage_rest":"2020-10-02T00:27:54+00:00","stage_cs_db":"2020-10-02T00:27:54+00:00","stage_cs_sent":"2020-10-02T00:27:54+00:00","stage_sm":"2020-10-02T00:27:54+00:00","stage_dev":"2020-10-02T00:27:56+00:00","stage_is":null,"stage_lv":"2020-10-02T00:27:56+00:00","stage_vs":null,"state_condition":"done","sm_ack":1,"lfr_ack":0,"sequence":365,"attempts":0,"transaction":"NIE5Fm36YSJGOOOn","player_transaction":"mrkXahUbYjfbUgHg","server":"rtsps://lv2-prod.immedia-semi.com:443/NIE5Fm36YSJGOOOn","duration":9,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f - liveview","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,365,205,151,159,167,0]},LV907","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":null,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// POST https://rest-prod.immedia-semi.com/api/v1/accounts/22156/networks/22022/state/arm
// {"id":750082190,"network_id":22022,"command":"arm","state":"new","commands":[{"id":750082191,"network_id":22022,"command":"config_lfr","state":"running"},{"id":750082192,"network_id":22022,"command":"config_lfr","state":"running"}]}
//
// POST             rest-prod.immedia-semi.com /api/v1/accounts/22156/networks/22022/state/disarm
// {"id":750082372,"network_id":22022,"command":"disarm","state":"new","commands":[{"id":750082373,"network_id":22022,"command":"config_lfr","state":"running"},{"id":750082374,"network_id":22022,"command":"config_lfr","state":"running"}]}
// GET https://rest-prod.immedia-semi.com/network/22022/command/750082372
//
// {"complete":true,"status":0,"status_msg":"Command succeeded","status_code":908,"commands":[{"id":750082372,"created_at":"2020-10-02T00:28:42+00:00","updated_at":"2020-10-02T00:28:42+00:00","execute_time":"2020-10-02T00:28:42+00:00","command":"disarm","state_stage":"sm","stage_rest":"2020-10-02T00:28:42+00:00","stage_cs_db":"2020-10-02T00:28:42+00:00","stage_cs_sent":"2020-10-02T00:28:42+00:00","stage_sm":"2020-10-02T00:28:42+00:00","stage_dev":null,"stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":1,"lfr_ack":null,"sequence":368,"attempts":0,"transaction":"9YCMRT02qHTVq2zI","player_transaction":"EzfAxyTe_d2fOBjK","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"","opts_1":0,"target":null,"target_id":null,"parent_command_id":null,"camera_id":null,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192},{"id":750082373,"created_at":"2020-10-02T00:28:42+00:00","updated_at":"2020-10-02T00:28:44+00:00","execute_time":"2020-10-02T00:28:42+00:00","command":"config_lfr","state_stage":"dev","stage_rest":"2020-10-02T00:28:42+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":"2020-10-02T00:28:44+00:00","stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":null,"lfr_ack":0,"sequence":null,"attempts":0,"transaction":"gIGTT5DqPQFAVi2-","player_transaction":"2clJK8w8ylh4EOvP","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,1,368,206,153,157,167,0]}","opts_1":0,"target":"camera","target_id":136989,"parent_command_id":750082372,"camera_id":136989,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192},{"id":750082374,"created_at":"2020-10-02T00:28:42+00:00","updated_at":"2020-10-02T00:28:44+00:00","execute_time":"2020-10-02T00:28:42+00:00","command":"config_lfr","state_stage":"dev","stage_rest":"2020-10-02T00:28:42+00:00","stage_cs_db":null,"stage_cs_sent":null,"stage_sm":null,"stage_dev":"2020-10-02T00:28:44+00:00","stage_is":null,"stage_lv":null,"stage_vs":null,"state_condition":"done","sm_ack":null,"lfr_ack":0,"sequence":null,"attempts":0,"transaction":"PoVq-TaTU1RaZjuR","player_transaction":"TSJ1eLMJawm5zp5a","server":null,"duration":null,"by_whom":"unknown - 6.1.1 (8854) #e06341d7f","diagnostic":false,"debug":"{\"lfr_ok\":[22022,2,368,215,144,149,171,0]}","opts_1":0,"target":"camera","target_id":13812,"parent_command_id":750082372,"camera_id":13812,"siren_id":null,"firmware_id":null,"network_id":22022,"account_id":22156,"sync_module_id":10192}],"media_id":null}
//
// GET              rest-prod.immedia-semi.com /api/v1/accounts/22156/media/changed?since=1970-01-01T00:00:01+0000&page=1
// {"limit":25,"purge_id":2139129532,"refresh_count":0,"media":[{"id":2139143115,"created_at":"2020-10-02T00:28:29+00:00","updated_at":"2020-10-02T00:28:31+00:00","deleted":false,"device":"camera","device_id":136989,"device_name":"Alpha","network_id":22022,"network_name":"82 Downing","type":"video","source":"pir","watched":false,"partial":false,"thumbnail":"/api/v2/accounts/22156/media/thumb/2139143115","media":"/api/v2/accounts/22156/media/clip/2139143115.mp4","additional_devices":[],"time_zone":"America/Tortola"}]}
//
// GET              rest-prod.immedia-semi.com /api/v1/accounts/22156/media/changed?since=2020-10-02T00:28:31+0000&page=1
//
// GET              rest-prod.immedia-semi.com /api/v2/accounts/22156/media/thumb/2139143115_s.jpg
// GET              rest-prod.immedia-semi.com /api/v1/accounts/22156/media/changed?since=2020-10-02T00:28:31+0000&page=1
// GET              rest-prod.immedia-semi.com /api/v1/accounts/22156/media/changed?since=2020-10-02T00:28:31+0000&page=1
//
// GET              rest-prod.immedia-semi.com /api/v2/accounts/22156/media/clip/2139143115.mp4
//
// POST             rest-prod.immedia-semi.com /api/v1/accounts/22156/notifications/configuration
// {"notifications":{"camera_usage":true}}
// {"message":"Client Notification Configure Update Successful"}
//
// GET              rest-prod.immedia-semi.com /api/v3/accounts/22156/homescreen
// POST             rest-prod.immedia-semi.com /network/22022/update
// {"dst":true,"lv_mode":"relay","time_zone":"America\/Toronto"}
// {"network":{"id":22022,"created_at":"2016-02-13T19:15:54+00:00","updated_at":"2020-10-02T00:29:30+00:00","deleted_at":null,"name":"82 Downing","network_key":"hifSnlicp+k4bLA=","description":"","network_origin":"normal","locale":"","time_zone":"America/Toronto","dst":true,"ping_interval":60,"encryption_key":null,"armed":false,"autoarm_geo_enable":false,"autoarm_time_enable":false,"lv_mode":"relay","lfr_channel":0,"video_destination":"server","storage_used":0,"storage_total":0,"video_count":0,"video_history_count":4000,"sm_backup_enabled":false,"arm_string":"Disarmed","busy":false,"camera_error":false,"sync_module_error":false,"feature_plan_id":null,"account_id":22156,"lv_save":false}}
//
// GET              rest-prod.immedia-semi.com /api/v1/networks/22022/programs
//
// POST             rest-prod.immedia-semi.com /api/v4/account/22156/client/2360401/logout
// GET              rest-prod.immedia-semi.com /api/v1/version
// GET              rest-prod.immedia-semi.com /regions?locale=CA