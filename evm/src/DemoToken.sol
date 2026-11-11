// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Jeton ERC-20 de demonstration avec un piege au choix. Deploye seulement sur une copie
/// locale de Base (anvil) : il montre ce que la sentinelle detecte, il ne s'echange nulle part.
contract DemoToken {
    enum Trap {
        None, // temoin sain
        OwnerReclaim, // le proprietaire reprend les jetons de n'importe qui par transferFrom
        SellBlocked, // toute vente vers la paire revert
        SellBlockedLater, // la vente passe juste apres l'achat, plus apres 10 minutes
        SellTax, // 90 % de chaque vente part au proprietaire
        SellTaxLater, // vente sans taxe juste apres l'achat, taxee a 90 % apres 10 minutes
        HoldOneBlock, // honnete : pas de vente dans le bloc de l'achat (anti-sandwich), libre ensuite
        SimDetector // la vente ne passe qu'en simulation : prix du gaz ou base fee nuls
    }

    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    address public immutable owner;
    Trap public immutable trap;
    address public pair;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public boughtAt;
    mapping(address => uint256) public boughtBlock;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, Trap trap_) {
        name = name_;
        symbol = symbol_;
        trap = trap_;
        owner = msg.sender;
        totalSupply = 1_000_000 ether;
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function setPair(address pair_) external {
        require(msg.sender == owner, "owner");
        pair = pair_;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (!(trap == Trap.OwnerReclaim && msg.sender == owner)) {
            uint256 allowed = allowance[from][msg.sender];
            require(allowed >= value, "allowance");
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        uint256 fee;
        if (to == pair && from != owner) {
            if (trap == Trap.SellBlocked) revert("vente fermee");
            if (trap == Trap.SellBlockedLater && block.timestamp > boughtAt[from] + 10 minutes) {
                revert("vente fermee apres 10 minutes");
            }
            if (trap == Trap.HoldOneBlock && block.number <= boughtBlock[from]) revert("hold one block");
            if (trap == Trap.SimDetector && tx.gasprice != 0 && block.basefee != 0) revert("real sale refused");
            if (trap == Trap.SellTax) fee = (value * 90) / 100;
            if (trap == Trap.SellTaxLater && block.timestamp > boughtAt[from] + 10 minutes) {
                fee = (value * 90) / 100;
            }
        }
        if (from == pair) {
            boughtAt[to] = block.timestamp;
            boughtBlock[to] = block.number;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value - fee;
        emit Transfer(from, to, value - fee);
        if (fee > 0) {
            balanceOf[owner] += fee;
            emit Transfer(from, owner, fee);
        }
    }
}
