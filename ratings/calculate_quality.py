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
trueskill.setup(mu=rating_base, sigma=rating_base / 3,
                beta=rating_base / 6, tau=rating_base / 300, backend='mpmath')


@click.command()
@click.argument('game_id')
def rate_game(game_id):
    game = db.games.find_one({'_id': ObjectId(game_id)})

    initial_ratings = []

    for index, team in enumerate(game['teams']):
        initial_team_ratings = {}

        for role in team['composition']:
            user = db.users.find_one(role['players'][0]['user'])
            user_rating = db.ratings.find_one(
                {'game': game['_id'], 'user': user['_id']})

            initial_team_ratings[user['_id']] = trueskill.Rating(mu=user_rating['before'][
                'mean'], sigma=user_rating['after']['deviation'])

        initial_ratings.append(initial_team_ratings)

    quality = trueskill.quality(initial_ratings)

    db.games.update({'_id': ObjectId(game_id)}, {
                    '$set': {'stats.predictedQuality': quality}})

if __name__ == '__main__':
    rate_game()
