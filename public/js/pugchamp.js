var socket = io();

socket.on('connect', function() {
    socket.emit('requestRestrictions');

    var tokenRequest = new XMLHttpRequest();

    tokenRequest.onreadystatechange = function() {
        if (tokenRequest.readyState === XMLHttpRequest.DONE) {
            if (tokenRequest.status === 200) {
                socket.emit('authenticate', {token: tokenRequest.responseText});
            }
            else if (tokenRequest.status !== 401) {
                throw new Error('Token request failed.');
            }
        }
    };

    tokenRequest.open('GET', '/user/token', true);
    tokenRequest.send(null);
});

socket.on('error', function(err) {
    if (error.type === 'UnauthorizedError' || error.code === 'invalid_token') {
        var tokenRequest = new XMLHttpRequest();

        tokenRequest.onreadystatechange = function() {
            if (tokenRequest.readyState === XMLHttpRequest.DONE) {
                if (tokenRequest.status === 200) {
                    socket.emit('authenticate', {token: tokenRequest.responseText});
                }
                else if (tokenRequest.status !== 401) {
                    throw new Error('Token request failed.');
                }
            }
        };

        tokenRequest.open('GET', '/user/token', true);
        tokenRequest.send(null);
    }
});

socket.on('authenticated', function() {
    socket.emit('requestRestrictions');
});

socket.on('restrictionsAvailable', function(restrictions, reasons) {
    $('#restriction-alerts').empty();
    reasons.forEach(function(reason) {
        $('<div class="alert alert-danger" role="alert"><i class="glyphicon glyphicon-alert"></i> ' + reason + '</div>').appendTo('#restriction-alerts');
    });

    if (restrictions.includes('play')) {
        $('.role-select input[type=checkbox]').prop('disabled', true);
        $('.role-select input[type=checkbox]').prop('hidden', true);
    }
    else {
        $('.role-select input[type=checkbox]').prop('disabled', false);
        $('.role-select input[type=checkbox]').prop('hidden', false);
    }

    if (restrictions.includes('play') || restrictions.includes('captain')) {
        // disable captain button
    }
    else {
        // enable captain button
    }

    if (restrictions.includes('chat')) {
        // disable chat box
    }
    else {
        // enable chat box
    }
});
