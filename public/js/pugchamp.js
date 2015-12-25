var socket = io();

function changeAvailability() {
    var roles = [];

    $('.role-select input[type=checkbox]:checked').each(function() {
        roles.push($(this).val());
    });

    var captain = $('#captain-select input[type=checkbox]').is(':checked');

    socket.emit('changeAvailability', {roles: roles, captain: captain});
}

$('.role-select input[type=checkbox]').on('change', changeAvailability);
$('#captain-select input[type=checkbox]').on('change', changeAvailability);

socket.on('connect', function() {
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

socket.on('statusUpdated', function(currentStatus) {
    $('.role-players template[is=dom-repeat]').each(function() {
        this.items = currentStatus.playersAvailable[this.dataset.type];
    });
});

socket.on('restrictionsUpdated', function(restrictions) {
    $('#restriction-alerts').empty();
    restrictions.reasons.forEach(function(reason) {
        $('<div class="alert alert-danger" role="alert"><i class="glyphicon glyphicon-alert"></i> ' + reason + '</div>').appendTo('#restriction-alerts');
    });

    if (restrictions.aspects.includes('play')) {
        $('.role-select input[type=checkbox]').prop('disabled', true);
        $('.role-select input[type=checkbox]').prop('hidden', true);
    }
    else {
        $('.role-select input[type=checkbox]').prop('disabled', false);
        $('.role-select input[type=checkbox]').prop('hidden', false);
    }

    if (restrictions.aspects.includes('play') || restrictions.aspects.includes('captain')) {
        $('#captain-select').prop('hidden', true);
        $('#captain-select input[type=checkbox]').prop('disabled', true);
    }
    else {
        $('#captain-select').prop('hidden', false);
        $('#captain-select input[type=checkbox]').prop('disabled', false);
    }

    if (restrictions.aspects.includes('chat')) {
        // disable chat box
    }
    else {
        // enable chat box
    }
});
