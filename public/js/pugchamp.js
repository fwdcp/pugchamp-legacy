var socket = io();

socket.on('connect', function() {
    var tokenRequest = new XMLHttpRequest();

    tokenRequest.onreadystatechange = function() {
        if (tokenRequest.readyState === XMLHttpRequest.DONE) {
            if (tokenRequest.status === 200) {
                console.log('Received token.');

                socket.emit('authenticate', {token: tokenRequest.responseText});
            }
            else if (tokenRequest.status === 401) {
                console.log('Not logged in.');
            }
            else {
                throw new Error('Invalid HTTP code received.');
            }
        }
    };

    tokenRequest.open('GET', '/auth/token', true);
    tokenRequest.send(null);
});

socket.on('authenticated', function() {
    console.log('Authenticated with the server.');
});
