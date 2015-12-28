var socket = io();

var notifications = false;

if (window.Notification) {
    if (Notification.permission === 'granted') {
        notifications = true;
    } else {
        Notification.requestPermission(function(result) {
            if (result === 'granted') {
                notifications = true;
            } else {
                notifications = false;
            }
        });
    }
} else {
    notifications = false;
}

function displayNotification(info) {
    if (notifications) {
        // TODO: update defaults

        var notification = new Notification('PugChamp', _.merge({}, info));
    }
}

var currentRestrictions;

var internalReadyStatusChange = false;

function updateReadyStatus() {
    if (internalReadyStatusChange) {
        return;
    }

    socket.emit('updateReadyStatus', $('#ready-dialog input[type=checkbox]').is(':checked'));
}

$('#ready-dialog input[type=checkbox]').on('change', updateReadyStatus);

socket.on('launchInProgress', function() {
    displayNotification({
        body: 'A new game is being launched.',
        tag: 'launchAttempt'
    });

    $('#ready-dialog').prop('hidden', false);

    if (!currentRestrictions.aspects.includes('start')) {
        $('#ready-dialog label').prop('hidden', false);
        $('#ready-dialog input[type=checkbox]').prop('disabled', false);
    }
});

socket.on('launchAborted', function() {
    $('#ready-dialog').prop('hidden', true);
    $('#ready-dialog label').prop('hidden', true);
    $('#ready-dialog input[type=checkbox]').prop('disabled', true);
});

socket.on('userReadyStatusUpdated', function(ready) {
    internalReadyStatusChange = true;

    if (ready) {
        $('#ready-dialog input[type=checkbox]').prop('checked', true);
    } else {
        $('#ready-dialog input[type=checkbox]').prop('checked', false);
    }

    internalReadyStatusChange = false;
});

socket.on('restrictionsUpdated', function(restrictions) {
    currentRestrictions = restrictions;

    if (restrictions.aspects.includes('chat')) {
        // disable chat box
    } else {
        // enable chat box
    }
});

socket.on('disconnect', function() {
    $('#disconnected-alert').prop('hidden', false);
});
