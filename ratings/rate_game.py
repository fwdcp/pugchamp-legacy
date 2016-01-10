from bson.objectid import ObjectId
import click
import ConfigParser
import datetime
from pymongo import MongoClient
import sys
import trueskill

config = ConfigParser.SafeConfigParser(
    {'connect': 'mongodb://localhost/', 'db': 'pugchamp', 'rating_base': '1500'})
config.read('settings.cfg')

client = MongoClient(config.get('config', 'connect'))
db = client[config.get('config', 'db')]

rating_base = config.getfloat('config', 'rating_base')
trueskill.setup(mu=rating_base, sigma=rating_base / 3, beta = rating_base / 6, tau = rating_base / 300)

@click.command()
@click.argument('game_id')
def rate_game(game_id):
    game = db.games.find_one({'_id': ObjectId(game_id)})

    players = game['players']
    users = {}

    old_team_0_ratings = {}
    old_team_1_ratings = {}

    weights = {}

    for player in players:
        user = db.users.find_one(player['user'])

        if 'currentRating' in user:
            rating_info = db.ratings.find_one(user['currentRating'])
            rating = trueskill.Rating(mu=rating_info['after']['rating'], sigma=rating_info['after']['deviation'])
        else:
            rating = trueskill.Rating()

        if player['team'] == 0:
            old_team_0_ratings[user['_id']] = rating
            if (game['results']['duration'] != 0):
                weights[(0, user['_id'])] = player['time'] / game['results']['duration']
        elif player['team'] == 1:
            old_team_1_ratings[user['_id']] = rating
            if (game['results']['duration'] != 0):
                weights[(1, user['_id'])] = player['time'] / game['results']['duration']

    if game['results']['score'][0] > game['results']['score'][1]:
        ranks = (0, 1)
    elif game['results']['score'][0] < game['results']['score'][1]:
        ranks = (1, 0)
    else:
        ranks = (0, 0)

    new_team_0_ratings, new_team_1_ratings = trueskill.rate((old_team_0_ratings, old_team_1_ratings), ranks=ranks, weights=weights)

    for player in players:
        if player['team'] == 0:
            old_rating = old_team_0_ratings[player['user']]
            new_rating = new_team_0_ratings[player['user']]
        elif player['team'] == 1:
            old_rating = old_team_1_ratings[player['user']]
            new_rating = new_team_1_ratings[player['user']]
        else:
            continue

        result = db.ratings.insert_one({'user': player['user'], 'date': datetime.datetime.now(), 'game': game['_id'], 'before': {'rating': old_rating.mu, 'deviation': old_rating.sigma}, 'after': {'rating': new_rating.mu, 'deviation': new_rating.sigma}})
        db.users.find_one_and_update({'_id': player['user']}, {'$set': {'currentRating': result.inserted_id}})

if __name__ == '__main__':
    rate_game()
