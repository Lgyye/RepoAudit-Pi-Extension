class Account:
    def __init__(self, name):
        self.name = name


def safe_lookup():
    account = Account("safe")
    return account.name
