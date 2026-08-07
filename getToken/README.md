# Retrieving Auth Token

1. Run the command:

   ```sh
   python pixiv_auth.py login
   ```

   This will open the browser with Pixiv login page.

2. Open dev console (F12) and switch to network tab.
3. Enable persistent logging ("Preserve log").
4. Type into the filter field: `callback?`
5. Proceed with Pixiv login.
6. After logging in you should see a blank page and request that looks like this: `https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?state=...&code=...`. Copy value of the `code` param into the `pixiv_auth.py`'s prompt and hit the <kbd>Enter</kbd> key.

If you did everything right and Pixiv did not change their auth flow, pair of `auth_token` and `refresh_token` should be displayed.

> :warning: `code`'s lifetime is extremely short, so make sure to minimize delay between step 5 and 6. Otherwise, repeat everything starting step 1.

# Refresh Tokens

```sh
python pixiv_auth.py refresh OLD_REFRESH_TOKEN
```